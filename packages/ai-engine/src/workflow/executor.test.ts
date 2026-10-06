/**
 * The workflow executor.
 *
 * Execution is data-dependent because a branch decides the next node at run time.
 * These tests pin the two consequences: the untaken side is reported as skipped
 * rather than absent, and a required input missing before the node runs fails the
 * workflow without spending a provider call.
 */
import { describe, expect, it, vi } from 'vitest';
import { evaluateBranch, WorkflowEngine } from './executor.js';
import type { AgentNode, BranchNode, OutputNode, WorkflowDefinition } from './definition.js';
import type { AgentResult } from '../agent-types.js';
import { AI_ERROR_CODE } from '../errors.js';

function agentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: 'generated',
    finishReason: 'stop',
    provider: 'OPENAI',
    model: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 5,
    costUsdMicros: 1_000,
    latencyMs: 20,
    structured: null,
    attempts: [],
    ...overrides,
  };
}

function linearDefinition(): WorkflowDefinition {
  const agent: AgentNode = {
    kind: 'agent',
    id: 'draft',
    model: null,
    provider: null,
    strategy: 'BALANCED',
    systemPrompt: 'You write {{input.topic}} articles.',
    userPrompt: 'Write about {{input.topic}}.',
    temperature: null,
    maxTokens: null,
    responseSchema: null,
    requires: ['input.topic'],
    optionalInputs: [],
  };
  const output: OutputNode = {
    kind: 'output',
    id: 'done',
    templates: { article: '{{nodes.draft.text}}', model: '{{nodes.draft.model}}' },
    requires: [],
    optionalInputs: [],
  };
  return { version: 1, nodes: [agent, output] };
}

describe('WorkflowEngine.run', () => {
  it('runs a linear workflow and merges the output node', async () => {
    const execute = vi.fn(() => Promise.resolve(agentResult()));
    const engine = new WorkflowEngine({ definition: linearDefinition(), agents: { execute } });

    const result = await engine.run({ topic: 'widgets' });

    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ article: 'generated', model: 'gpt-4o' });
    expect(result.totalCostUsdMicros).toBe(1_000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('renders the agent prompt from the input scope', async () => {
    const execute = vi.fn(() => Promise.resolve(agentResult()));
    const engine = new WorkflowEngine({ definition: linearDefinition(), agents: { execute } });

    await engine.run({ topic: 'widgets' });

    expect(execute.mock.calls[0]?.[1]).toEqual([
      { role: 'system', content: 'You write widgets articles.' },
      { role: 'user', content: 'Write about widgets.' },
    ]);
  });

  it('exposes structured output alongside text', async () => {
    const execute = vi.fn(() => Promise.resolve(agentResult({ structured: { title: 'T' } })));
    const agent: AgentNode = {
      ...(linearDefinition().nodes[0] as AgentNode),
      id: 'draft',
    };
    const output: OutputNode = {
      kind: 'output',
      id: 'done',
      templates: { title: '{{nodes.draft.structured.title}}' },
      requires: [],
      optionalInputs: [],
    };

    const result = await new WorkflowEngine({
      definition: { version: 1, nodes: [agent, output] },
      agents: { execute },
    }).run({ topic: 'widgets' });

    expect(result.output).toEqual({ title: 'T' });
  });

  it('takes the chosen branch and reports the untaken side as skipped', async () => {
    const execute = vi.fn(() => Promise.resolve(agentResult()));
    const def: WorkflowDefinition = {
      version: 1,
      nodes: [
        { ...branch('route', 'yes', 'no'), path: 'input.go' },
        { ...output('yes'), templates: { path: 'YES' } },
        { ...output('no'), templates: { path: 'NO' } },
      ],
    };
    const engine = new WorkflowEngine({ definition: def, agents: { execute } });

    const result = await engine.run({ go: true });

    expect(result.output).toEqual({ path: 'YES' });
    expect(result.nodeResults.find((node) => node.nodeId === 'no')).toMatchObject({
      status: 'skipped',
      skippedBecause: 'a branch chose a different path',
    });
    expect(result.nodeResults.find((node) => node.nodeId === 'yes')?.status).toBe('succeeded');
  });

  it('fails before spending a provider call when a required input is missing', async () => {
    const execute = vi.fn(() => Promise.resolve(agentResult()));
    const engine = new WorkflowEngine({ definition: linearDefinition(), agents: { execute } });

    const result = await engine.run({});

    expect(result.status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    expect((result.failure?.error as { message: string }).message).toMatch(/input.topic/);
  });

  it('fails the workflow when a node throws, rather than retrying internally', async () => {
    const execute = vi.fn(() => Promise.reject(new Error('provider exploded')));
    const engine = new WorkflowEngine({ definition: linearDefinition(), agents: { execute } });

    const result = await engine.run({ topic: 'widgets' });

    expect(result.status).toBe('failed');
    expect(result.failure?.nodeId).toBe('draft');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('validates the definition in the constructor', () => {
    expect(
      () =>
        new WorkflowEngine({ definition: { version: 1, nodes: [] }, agents: { execute: vi.fn() } }),
    ).toThrow(/at least one node/);
  });

  it('stops after maxNodes', async () => {
    const execute = vi.fn(() => Promise.resolve(agentResult()));
    // A valid chain of branches: n0 -> n1 -> n2, each reachable from n0.
    const chain: WorkflowDefinition = {
      version: 1,
      nodes: [branch('n0', 'n1', null), branch('n1', 'n2', null), output('n2')],
    };
    const engine = new WorkflowEngine({ definition: chain, agents: { execute }, maxNodes: 1 });

    const result = await engine.run({ go: true });

    expect(result.status).toBe('failed');
    expect((result.failure?.error as { code: string }).code).toBe(AI_ERROR_CODE.WorkflowInvalid);
  });
});

function branch(id: string, then: string, otherwise: string | null): BranchNode {
  return {
    kind: 'branch',
    id,
    path: 'input.go',
    equals: true,
    operator: 'eq',
    then,
    otherwise,
    requires: [],
    optionalInputs: [],
  };
}

function output(id: string): OutputNode {
  return { kind: 'output', id, templates: {}, requires: [], optionalInputs: [] };
}

describe('evaluateBranch', () => {
  const scope = {
    input: { count: 10, name: 'acme', missing: undefined },
    nodes: {},
    vars: {},
  } as never;

  function node(overrides: Partial<BranchNode>): BranchNode {
    return { ...branch('b', 'yes', 'no'), ...overrides };
  }

  it('does strict equality for eq, so a string 10 is not a number 10', () => {
    expect(evaluateBranch(node({ path: 'input.name', operator: 'eq', equals: 10 }), scope)).toBe(
      'no',
    );
    expect(evaluateBranch(node({ path: 'input.count', operator: 'eq', equals: 10 }), scope)).toBe(
      'yes',
    );
  });

  it('does not coerce operands for numeric comparisons', () => {
    const actual = { input: { ten: '10' }, nodes: {}, vars: {} } as never;
    expect(evaluateBranch(node({ path: 'input.ten', operator: 'gt', equals: 5 }), actual)).toBe(
      'no',
    );
  });

  it('tests containment for strings and arrays', () => {
    const s = { input: { name: 'acme corp', tags: ['a', 'b'] }, nodes: {}, vars: {} } as never;
    expect(
      evaluateBranch(node({ path: 'input.name', operator: 'contains', equals: 'acme' }), s),
    ).toBe('yes');
    expect(evaluateBranch(node({ path: 'input.tags', operator: 'contains', equals: 'b' }), s)).toBe(
      'yes',
    );
    expect(evaluateBranch(node({ path: 'input.tags', operator: 'contains', equals: 'z' }), s)).toBe(
      'no',
    );
  });

  it('tests existence via exists', () => {
    expect(evaluateBranch(node({ path: 'input.count', operator: 'exists' }), scope)).toBe('yes');
    expect(evaluateBranch(node({ path: 'input.nope', operator: 'exists' }), scope)).toBe('no');
  });

  it('falls through to then when otherwise is null', () => {
    expect(
      evaluateBranch(node({ otherwise: null, path: 'input.nope', operator: 'exists' }), scope),
    ).toBe('yes');
  });
});
