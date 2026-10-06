/**
 * Workflow definitions and validation.
 *
 * A workflow is a **directed acyclic graph of typed nodes**. Each node declares
 * its input and output shape by name, and every edge declares which fields it
 * carries. That strictness is the point: a workflow is tenant-authored data
 * crossing into code that spends money and writes to a database, and the failures
 * an untyped graph produces — a node reading a field a renamed predecessor no
 * longer emits, a branch on a comparison against a string where a number was
 * promised — surface as a plausible-looking wrong result rather than an error.
 *
 * Validation is exhaustive and runs before any provider is called, so a broken
 * definition costs a `WORKFLOW_INVALID` failure rather than three successful LLM
 * calls and a corrupted output.
 */
import type { JsonSchema } from '../structured.js';

export type WorkflowNodeKind = 'agent' | 'transform' | 'branch' | 'output';

/** A workflow input or output document. Free-form; nodes name the paths they use. */
export type WorkflowData = Readonly<Record<string, unknown>>;

export interface AgentNode {
  readonly kind: 'agent';
  readonly id: string;
  /** Model id to request. Null lets the router choose by strategy. */
  readonly model: string | null;
  readonly provider: string | null;
  readonly strategy: string;
  /** Templates rendered against the node's input scope. */
  readonly systemPrompt: string | null;
  readonly userPrompt: string;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  /** JSON Schema for structured output. Null means free text. */
  readonly responseSchema: JsonSchema | null;
  /** Input paths this node requires. Validated before the node runs. */
  readonly requires: readonly string[];
  /** Input paths this node reads that may be absent. */
  readonly optionalInputs: readonly string[];
}

export interface TransformNode {
  readonly kind: 'transform';
  readonly id: string;
  /** Output field name this node writes. */
  readonly outputKey: string;
  /** Templates producing each output field, keyed by field name. */
  readonly templates: Readonly<Record<string, string>>;
  readonly requires: readonly string[];
  readonly optionalInputs: readonly string[];
}

export interface BranchNode {
  readonly kind: 'branch';
  readonly id: string;
  /** Input path holding the value to test. */
  readonly path: string;
  readonly equals: string | number | boolean | null;
  readonly operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';
  /** Next node id when the test passes. */
  readonly then: string;
  /** Next node id when it fails. Omitted means the branch terminates. */
  readonly otherwise: string | null;
  readonly requires: readonly string[];
  readonly optionalInputs: readonly string[];
}

export interface OutputNode {
  readonly kind: 'output';
  readonly id: string;
  /** Templates producing each output field, keyed by field name. */
  readonly templates: Readonly<Record<string, string>>;
  readonly requires: readonly string[];
  readonly optionalInputs: readonly string[];
}

export type WorkflowNode = AgentNode | TransformNode | BranchNode | OutputNode;

export interface WorkflowDefinition {
  readonly version: 1;
  readonly nodes: readonly WorkflowNode[];
  /** Ids of nodes to start from. Defaults to every node with no incoming edge. */
  readonly entryNodes?: readonly string[];
}

/** Why a definition is invalid. Every problem is reported, not just the first. */
export interface WorkflowProblem {
  readonly nodeId: string | null;
  readonly message: string;
}

export class WorkflowDefinitionError extends Error {
  constructor(readonly problems: readonly WorkflowProblem[]) {
    super(
      `Workflow definition is invalid:\n` +
        problems
          .map((p) => `  ${p.nodeId === null ? 'workflow' : `node "${p.nodeId}"`}: ${p.message}`)
          .join('\n'),
    );
    this.name = 'WorkflowDefinitionError';
  }
}

/**
 * Validates a definition.
 *
 * Checks, in order:
 *
 * 1. Node ids are unique and non-empty.
 * 2. Every `requires` path is a plausible identifier.
 * 3. Every branch target exists.
 * 4. The graph is acyclic.
 * 5. Every node is reachable from an entry node.
 * 6. There is at least one node.
 *
 * All problems are collected rather than thrown one at a time. A workflow author
 * fixing errors one restart per mistake is a workflow that takes a week to
 * validate.
 *
 * @throws {WorkflowDefinitionError} with every problem found.
 */
export function validateWorkflow(definition: WorkflowDefinition): void {
  const problems: WorkflowProblem[] = [];

  if (definition.nodes.length === 0) {
    problems.push({ nodeId: null, message: 'A workflow must have at least one node.' });
    throw new WorkflowDefinitionError(problems);
  }

  // 1. Unique, non-empty ids.
  const byId = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (node.id.trim() === '') {
      problems.push({ nodeId: null, message: 'Node ids must not be empty.' });
      continue;
    }
    if (byId.has(node.id)) {
      problems.push({ nodeId: node.id, message: 'Duplicate node id.' });
      continue;
    }
    byId.set(node.id, node);
  }

  // 2. Required paths must look like paths, not template syntax or prose.
  for (const node of byId.values()) {
    for (const path of node.requires) {
      if (!isValidPath(path)) {
        problems.push({
          nodeId: node.id,
          message: `"${path}" is not a valid input path. Use dotted segments like "customer.name".`,
        });
      }
    }
    for (const path of node.optionalInputs) {
      if (!isValidPath(path)) {
        problems.push({
          nodeId: node.id,
          message: `"${path}" is not a valid optional input path.`,
        });
      }
    }
    // A path cannot be both required and optional; the engine would honour
    // whichever check ran first, and the intent is ambiguous.
    for (const path of node.optionalInputs) {
      if (node.requires.includes(path)) {
        problems.push({
          nodeId: node.id,
          message: `"${path}" is listed as both required and optional.`,
        });
      }
    }
  }

  // 3. Branch targets must exist. A dangling branch is the failure that makes a
  // workflow silently skip half its work.
  for (const node of byId.values()) {
    if (node.kind !== 'branch') continue;
    if (!byId.has(node.then)) {
      problems.push({ nodeId: node.id, message: `Branch target "${node.then}" does not exist.` });
    }
    if (node.otherwise !== null && !byId.has(node.otherwise)) {
      problems.push({
        nodeId: node.id,
        message: `Branch fallback "${node.otherwise}" does not exist.`,
      });
    }
    if (node.otherwise === node.then) {
      problems.push({
        nodeId: node.id,
        message: 'Branch points at the same node for both outcomes, which is a no-op.',
      });
    }
  }

  const edges = buildEdges(definition, byId);

  // 4. Cycles.
  const cycle = findCycle(byId, edges);
  if (cycle !== null) {
    problems.push({
      nodeId: cycle[0] ?? null,
      message: `Nodes form a cycle: ${cycle.join(' -> ')}. Workflows must be acyclic.`,
    });
  }

  // 5. Reachability.
  const entryNodes = resolveEntryNodes(definition, byId, edges);
  if (entryNodes.length === 0) {
    problems.push({
      nodeId: null,
      message: 'No entry nodes: every node has an incoming edge, so the graph is closed.',
    });
  } else {
    const reachable = new Set<string>();
    const queue = [...entryNodes];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || reachable.has(id)) continue;
      reachable.add(id);
      for (const next of edges.get(id) ?? []) queue.push(next);
    }

    for (const id of byId.keys()) {
      if (!reachable.has(id)) {
        problems.push({
          nodeId: id,
          message: 'Node is unreachable from any entry node and will never run.',
        });
      }
    }
  }

  if (problems.length > 0) throw new WorkflowDefinitionError(problems);
}

/**
 * Builds the adjacency map.
 *
 * Derived from branch targets rather than a separate `edges` array, so a
 * definition cannot contain an edge that validation does not check. An explicit
 * edge list alongside branches is a place for the two to disagree, and the
 * disagreement is always a node that silently never runs.
 */
function buildEdges(
  _definition: WorkflowDefinition,
  byId: ReadonlyMap<string, WorkflowNode>,
): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const id of byId.keys()) edges.set(id, []);

  for (const node of byId.values()) {
    if (node.kind !== 'branch') continue;
    const targets = edges.get(node.id);
    if (targets === undefined) continue;
    targets.push(node.then);
    if (node.otherwise !== null) targets.push(node.otherwise);
  }

  return edges;
}

/** Entry nodes: explicit if given, else every node with no incoming edge. */
function resolveEntryNodes(
  definition: WorkflowDefinition,
  byId: ReadonlyMap<string, WorkflowNode>,
  edges: ReadonlyMap<string, string[]>,
): readonly string[] {
  if (definition.entryNodes !== undefined) {
    return definition.entryNodes.filter((id) => byId.has(id));
  }

  const hasIncoming = new Set<string>();
  for (const targets of edges.values()) {
    for (const target of targets) hasIncoming.add(target);
  }

  return [...byId.keys()].filter((id) => !hasIncoming.has(id));
}

/**
 * Finds a cycle with an iterative depth-first search.
 *
 * Iterative rather than recursive because a workflow can have hundreds of nodes
 * and a deeply linear chain would blow the stack — turning a validation error into
 * a `RangeError`, which tells the author nothing.
 */
function findCycle(
  byId: ReadonlyMap<string, WorkflowNode>,
  edges: ReadonlyMap<string, string[]>,
): readonly string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colours = new Map<string, number>();
  for (const id of byId.keys()) colours.set(id, WHITE);

  for (const start of byId.keys()) {
    if (colours.get(start) !== WHITE) continue;

    const path: string[] = [];
    const stack: { id: string; index: number }[] = [{ id: start, index: 0 }];
    colours.set(start, GREY);
    path.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      const targets = edges.get(frame.id) ?? [];
      if (frame.index >= targets.length) {
        colours.set(frame.id, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const next = targets[frame.index];
      frame.index++;
      if (next === undefined) continue;

      const colour = colours.get(next);
      if (colour === GREY) {
        // Back edge. Report the cycle from where it started, so the message names
        // the actual loop rather than the whole path that reached it.
        const start = path.indexOf(next);
        return [...path.slice(start), next];
      }
      if (colour === WHITE) {
        colours.set(next, GREY);
        path.push(next);
        stack.push({ id: next, index: 0 });
      }
    }
  }

  return null;
}

/**
 * A valid input path: dot-separated identifiers, numeric segments allowed for
 * array indices.
 *
 * Rejects empty segments (`a..b`), leading or trailing dots, and anything outside
 * word characters, digits, `_`, `$` and `-`. Those characters are the ones that
 * reach `resolvePath`, and a path containing `__proto__` is a prototype-pollution
 * attempt even though `resolvePath` also refuses it — validation reports it
 * clearly, the resolver defends itself silently.
 */
function isValidPath(path: string): boolean {
  if (path === '') return false;
  const segments = path.split('.');
  return segments.every((segment) => /^[A-Za-z_$][\w$-]*$/.test(segment) || /^\d+$/.test(segment));
}
