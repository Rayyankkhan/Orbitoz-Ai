/**
 * The workflow execution engine.
 *
 * Node kinds, and why there are exactly four:
 *
 * - **`agent`** — the only kind that calls a provider. Everything else is free,
 *   which is what makes a mixed workflow's cost predictable.
 * - **`transform`** — render templates into an output object. No model involved.
 * - **`branch`** — test a value and pick the next node. A real conditional, not a
 *   model asked "which branch?"; a model that has to decide routing makes every
 *   workflow non-deterministic and costs a call to save three lines of code.
 * - **`output`** — the workflow's terminal result.
 *
 * Execution is **step-by-step over a work queue**, not a topological sort, because
 * a branch makes the execution order data-dependent: which nodes run depends on
 * values only known at run time. A precomputed topological order is correct for a
 * diamond but wrong for a branch whose target has a different dependency
 * position, and the second case fails in a way that looks like the branch simply
 * did not fire.
 *
 * Every node runs inside the caller's tenant scope. The engine never receives a
 * tenant id and never establishes one — it has no idea tenancy exists. That is
 * deliberate: an executor that took a `tenantId` parameter would have a second
 * place to derive it, and two places to derive a tenant id is how two places end
 * up disagreeing.
 */
import { AiProviderError, AI_ERROR_CODE } from '../errors.js';
import { renderPrompt, resolvePath, PromptTemplateError } from '../prompt.js';
import type { AgentAttempt, AgentResult } from '../agent-types.js';
import type { ChatMessage } from '../providers/contracts.js';
import type {
  AgentNode,
  BranchNode,
  OutputNode,
  TransformNode,
  WorkflowData,
  WorkflowDefinition,
  WorkflowNode,
} from './definition.js';
import { validateWorkflow } from './definition.js';

export interface AgentExecutionContext {
  /** Routes a request for one agent node. Injected so tests need no provider. */
  readonly execute: (node: AgentNode, messages: readonly ChatMessage[]) => Promise<AgentResult>;
}

/** The accumulated scope, visible to every node as `nodes.<id>.<field>`. */
export interface WorkflowScope extends WorkflowData {
  readonly input: WorkflowData;
  readonly nodes: Readonly<Record<string, WorkflowData>>;
  /** Prompt variables a workflow author may reference. Always tenant-scoped. */
  readonly vars: WorkflowData;
}

export interface NodeResult {
  readonly nodeId: string;
  readonly kind: WorkflowNode['kind'];
  readonly status: 'succeeded' | 'skipped';
  readonly output: WorkflowData;
  readonly durationMs: number;
  /** Present when the node called a provider. */
  readonly agent: AgentResult | null;
  /** Why the node was skipped. Null when it ran. */
  readonly skippedBecause: string | null;
}

export interface WorkflowRunResult {
  readonly status: 'succeeded' | 'failed';
  readonly output: WorkflowData;
  readonly nodeResults: readonly NodeResult[];
  readonly totalCostUsdMicros: number;
  readonly totalLatencyMs: number;
  readonly failure: { readonly nodeId: string; readonly error: unknown } | null;
}

export interface WorkflowEngineOptions {
  readonly definition: WorkflowDefinition;
  readonly agents: AgentExecutionContext;
  /** Ceiling on nodes executed. Guards against a definition that loops in practice. */
  readonly maxNodes?: number;
  /** Injected clock, so tests can assert on durations without sleeping. */
  readonly now?: () => number;
}

/** 200 nodes is far beyond any real workflow and well under anything harmful. */
const DEFAULT_MAX_NODES = 200;

export class WorkflowEngine {
  private readonly definition: WorkflowDefinition;
  private readonly agents: AgentExecutionContext;
  private readonly maxNodes: number;
  private readonly now: () => number;

  constructor(options: WorkflowEngineOptions) {
    // Validation runs in the constructor, so an invalid definition cannot be
    // executed even if a caller forgets to validate — which is the mistake that
    // turns a typo into a job that burns tokens before failing.
    validateWorkflow(options.definition);
    this.definition = options.definition;
    this.agents = options.agents;
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    this.now = options.now ?? Date.now;
  }

  async run(input: WorkflowData, vars: WorkflowData = {}): Promise<WorkflowRunResult> {
    const startedAt = this.now();
    const nodes = new Map(this.definition.nodes.map((node) => [node.id, node]));
    const edges = this.buildAdjacency();
    const entryNodes = this.resolveEntryNodes(nodes, edges);

    const scope: { input: WorkflowData; nodes: Record<string, WorkflowData>; vars: WorkflowData } =
      {
        input,
        nodes: {},
        vars,
      };

    const nodeResults: NodeResult[] = [];
    const executed = new Set<string>();
    const skipped = new Map<string, string>();

    let totalCostUsdMicros = 0;

    // A node is queued only once it has actually run, so a branch's unchosen side
    // is never enqueued. That is what makes skipping transitive: skipping a node
    // skips everything downstream of it.
    const queue: string[] = [...entryNodes];

    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (nodeId === undefined) continue;

      if (executed.has(nodeId)) continue;

      if (skipped.has(nodeId)) {
        // Add to `executed` so the node is reported exactly once, even if a path
        // enqueued it before the branch that marked it skipped.
        executed.add(nodeId);
        nodeResults.push({
          nodeId,
          kind: nodes.get(nodeId)?.kind ?? 'transform',
          status: 'skipped',
          output: {},
          durationMs: 0,
          agent: null,
          skippedBecause: skipped.get(nodeId) ?? 'an upstream node was skipped',
        });
        continue;
      }

      if (nodeResults.length >= this.maxNodes) {
        return {
          status: 'failed',
          output: {},
          nodeResults,
          totalCostUsdMicros,
          totalLatencyMs: this.now() - startedAt,
          failure: {
            nodeId,
            error: new AiProviderError({
              code: AI_ERROR_CODE.WorkflowInvalid,
              message: `Workflow executed more than ${this.maxNodes} nodes and was stopped.`,
            }),
          },
        };
      }

      const node = nodes.get(nodeId);
      if (node === undefined) {
        // Validation checked branch targets, so this is unreachable unless the
        // definition was mutated after construction.
        throw new AiProviderError({
          code: AI_ERROR_CODE.WorkflowInvalid,
          message: `Node "${nodeId}" is queued but does not exist.`,
        });
      }

      const nodeStartedAt = this.now();

      try {
        const result = await this.runNode(node, scope);
        executed.add(nodeId);
        scope.nodes[nodeId] = result.output;

        if (result.agent !== null) {
          totalCostUsdMicros += result.agent.costUsdMicros;
        }

        nodeResults.push({
          nodeId,
          kind: node.kind,
          status: 'succeeded',
          output: result.output,
          durationMs: this.now() - nodeStartedAt,
          agent: result.agent,
          skippedBecause: null,
        });

        // Enqueue successors. A branch enqueues exactly one side.
        if (node.kind === 'branch') {
          const taken = evaluateBranch(node, scope);
          queue.push(taken);
          // Mark the untaken side and everything only it reaches as skipped, so a
          // skipped node is visible in the result rather than silently absent.
          const untaken = taken === node.then ? node.otherwise : node.then;
          if (untaken !== null) this.markSkipped(untaken, edges, skipped, nodes, executed, queue);
        } else {
          for (const next of edges.get(nodeId) ?? []) queue.push(next);
        }
      } catch (error) {
        // A node failure fails the workflow rather than retrying internally. The
        // job's own BullMQ retry budget handles the whole-workflow retry, which is
        // the granularity a tenant understands; a per-node retry would multiply
        // provider calls invisibly.
        nodeResults.push({
          nodeId,
          kind: node.kind,
          status: 'skipped',
          output: {},
          durationMs: this.now() - nodeStartedAt,
          agent: null,
          skippedBecause: `failed: ${error instanceof Error ? error.message : String(error)}`,
        });

        return {
          status: 'failed',
          output: {},
          nodeResults,
          totalCostUsdMicros,
          totalLatencyMs: this.now() - startedAt,
          failure: { nodeId, error },
        };
      }
    }

    // The workflow's output is the merged output of every `output` node, in
    // definition order. Merging rather than taking the last one means parallel
    // branches can each contribute fields to the same result.
    const output: Record<string, unknown> = {};
    for (const node of this.definition.nodes) {
      if (node.kind !== 'output') continue;
      const produced = scope.nodes[node.id];
      if (produced === undefined) continue;
      Object.assign(output, produced);
    }

    return {
      status: 'succeeded',
      output,
      nodeResults,
      totalCostUsdMicros,
      totalLatencyMs: this.now() - startedAt,
      failure: null,
    };
  }

  /**
   * Marks a node and its unexecuted descendants as skipped.
   *
   * Stops at nodes already executed or already marked, so a diamond where the two
   * paths converge does not report the shared tail as skipped twice.
   */
  private markSkipped(
    startId: string,
    edges: ReadonlyMap<string, string[]>,
    skipped: Map<string, string>,
    nodes: ReadonlyMap<string, WorkflowNode>,
    executed: ReadonlySet<string>,
    queue: string[],
  ): void {
    const stack = [startId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined) continue;
      if (executed.has(id) || skipped.has(id)) continue;

      skipped.set(id, 'a branch chose a different path');
      // Enqueue it so the main loop emits a `skipped` result for it. Without
      // this, the untaken side is absent from `nodeResults` entirely and a tenant
      // cannot tell a node that was skipped from one that was never part of the
      // run.
      queue.push(id);
      for (const next of edges.get(id) ?? []) {
        const node = nodes.get(next);
        // Never traverse *through* a branch: a branch's own target list is
        // conditional, and the not-taken path of a branch further down is
        // determined by its own condition, not by this one.
        if (node?.kind === 'branch') continue;
        stack.push(next);
      }
    }
  }

  private async runNode(
    node: WorkflowNode,
    scope: WorkflowScope,
  ): Promise<{ output: WorkflowData; agent: AgentResult | null }> {
    // Required inputs are checked before the node runs, so a missing dependency
    // is a clear error naming the path rather than a prompt rendered with a hole
    // in it.
    const missing = node.requires.filter((path) => resolvePath(scope, path) === undefined);
    if (missing.length > 0) {
      throw new AiProviderError({
        code: AI_ERROR_CODE.WorkflowInvalid,
        message:
          `Node "${node.id}" requires ${missing.length} input(s) that are not in scope: ` +
          `${missing.join(', ')}. Available: ${describeScope(scope)}.`,
      });
    }

    switch (node.kind) {
      case 'agent': {
        const messages = this.buildMessages(node, scope);
        const agent = await this.agents.execute(node, messages);
        const output: Record<string, unknown> = { text: agent.text };

        // Structured output is exposed under its own key as well as `text`, so a
        // downstream template can reference either without the engine deciding
        // which form is canonical.
        if (agent.structured !== null) output.structured = agent.structured;

        output.provider = agent.provider;
        output.model = agent.model;
        return { output, agent };
      }

      case 'transform':
      case 'output': {
        const output = this.renderTemplates(node.templates, scope, node.id);
        return { output, agent: null };
      }

      case 'branch': {
        // A branch produces no output; its result is which node runs next.
        return { output: {}, agent: null };
      }
    }
  }

  private buildMessages(node: AgentNode, scope: WorkflowScope): ChatMessage[] {
    const optional = [...node.optionalInputs];

    const messages: ChatMessage[] = [];
    if (node.systemPrompt !== null && node.systemPrompt.trim() !== '') {
      messages.push({
        role: 'system',
        content: this.render(node.systemPrompt, scope, optional, node.id),
      });
    }
    messages.push({
      role: 'user',
      content: this.render(node.userPrompt, scope, optional, node.id),
    });
    return messages;
  }

  private renderTemplates(
    templates: Readonly<Record<string, string>>,
    scope: WorkflowScope,
    nodeId: string,
  ): WorkflowData {
    const output: Record<string, unknown> = {};
    // Optional paths are declared per node, and they apply to every template in it.
    // A transform writing three fields from three sources should not need to
    // declare the same optional path three times.
    const node = this.definition.nodes.find((candidate) => candidate.id === nodeId);
    const optional = node === undefined ? [] : [...node.optionalInputs];

    for (const [key, template] of Object.entries(templates)) {
      output[key] = this.render(template, scope, optional, nodeId, key);
    }
    return output;
  }

  private render(
    template: string,
    scope: WorkflowScope,
    optional: readonly string[],
    nodeId: string,
    field?: string,
  ): string {
    try {
      return renderPrompt(template, scope, { optionalPaths: optional });
    } catch (error) {
      if (error instanceof PromptTemplateError) {
        throw new AiProviderError({
          code: AI_ERROR_CODE.WorkflowInvalid,
          message: `Node "${nodeId}"${field === undefined ? '' : ` field "${field}"`}: ${error.message}`,
          cause: error,
        });
      }
      throw error;
    }
  }

  private buildAdjacency(): Map<string, string[]> {
    const adjacency = new Map<string, string[]>();
    for (const node of this.definition.nodes) adjacency.set(node.id, []);
    for (const node of this.definition.nodes) {
      if (node.kind !== 'branch') continue;
      adjacency.get(node.id)?.push(node.then);
      if (node.otherwise !== null) adjacency.get(node.id)?.push(node.otherwise);
    }
    return adjacency;
  }

  private resolveEntryNodes(
    nodes: ReadonlyMap<string, WorkflowNode>,
    edges: ReadonlyMap<string, string[]>,
  ): readonly string[] {
    if (this.definition.entryNodes !== undefined) {
      return this.definition.entryNodes;
    }
    const hasIncoming = new Set<string>();
    for (const targets of edges.values()) {
      for (const target of targets) hasIncoming.add(target);
    }
    return [...nodes.keys()].filter((id) => !hasIncoming.has(id));
  }
}

/**
 * Evaluates a branch condition.
 *
 * Strict about types. `'10' > 5` is false in JavaScript and the naive version of
 * this would coerce it to true, so a workflow comparing a form field that arrived
 * as a string would take a different path than intended — silently, and only for
 * the inputs where the types happened to differ.
 *
 * `null` in `equals` is compared with `Object.is`, so it is a genuine null check
 * rather than a loose equality that would also match `undefined`.
 */
export function evaluateBranch(node: BranchNode, scope: WorkflowScope): string {
  const actual = resolvePath(scope, node.path);

  let passed: boolean;
  switch (node.operator) {
    case 'exists':
      passed = actual !== undefined && actual !== null;
      break;
    case 'eq':
      passed = strictEquals(actual, node.equals);
      break;
    case 'neq':
      passed = !strictEquals(actual, node.equals);
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // Numeric comparisons only. A non-number operand fails the test rather than
      // coercing: `"abc" > 5` is false and so is `NaN > 5`, but coercing `"10"`
      // to 10 is the case that hides a bug.
      if (typeof actual !== 'number' || typeof node.equals !== 'number') {
        passed = false;
        break;
      }
      passed =
        node.operator === 'gt'
          ? actual > node.equals
          : node.operator === 'gte'
            ? actual >= node.equals
            : node.operator === 'lt'
              ? actual < node.equals
              : actual <= node.equals;
      break;
    }
    case 'contains': {
      if (typeof actual === 'string') {
        passed = typeof node.equals === 'string' && actual.includes(node.equals);
      } else if (Array.isArray(actual)) {
        passed = actual.includes(node.equals);
      } else {
        passed = false;
      }
      break;
    }
    default: {
      const _exhaustive: never = node.operator;
      throw new Error(`Unhandled branch operator: ${String(_exhaustive)}`);
    }
  }

  return passed ? node.then : (node.otherwise ?? node.then);
}

function strictEquals(actual: unknown, expected: unknown): boolean {
  return Object.is(actual, expected);
}

/** A readable inventory of what a node can see, for a "missing input" error. */
function describeScope(scope: WorkflowScope): string {
  const parts = [`input{${Object.keys(scope.input).join(',')}}`];
  for (const [nodeId, data] of Object.entries(scope.nodes)) {
    parts.push(`${nodeId}{${Object.keys(data).join(',')}}`);
  }
  if (Object.keys(scope.vars).length > 0) {
    parts.push(`vars{${Object.keys(scope.vars).join(',')}}`);
  }
  return parts.join(' ');
}

/** Convenience for a transform/output node's template map. */
export function templates(
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return fields;
}

export type { TransformNode, OutputNode, AgentAttempt, AgentResult };
