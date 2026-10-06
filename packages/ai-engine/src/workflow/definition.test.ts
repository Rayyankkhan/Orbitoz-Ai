/**
 * Workflow definition validation.
 *
 * Validation is exhaustive and runs before any provider call, so a broken
 * definition costs a `WORKFLOW_INVALID` error rather than several successful LLM
 * calls and a corrupted output.
 */
import { describe, expect, it } from 'vitest';
import { validateWorkflow } from './definition.js';
import type {
  BranchNode,
  OutputNode,
  TransformNode,
  WorkflowDefinition,
  WorkflowDefinitionError,
} from './definition.js';

function output(id: string): OutputNode {
  return {
    kind: 'output',
    id,
    templates: { result: '{{input.value}}' },
    requires: [],
    optionalInputs: [],
  };
}

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

function transform(
  id: string,
  requires: readonly string[] = [],
  optionalInputs: readonly string[] = [],
): TransformNode {
  return {
    kind: 'transform',
    id,
    outputKey: 'out',
    templates: { out: '{{input.value}}' },
    requires,
    optionalInputs,
  };
}

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { version: 1, nodes: [output('done')], ...overrides };
}

describe('validateWorkflow', () => {
  it('accepts a minimal valid workflow', () => {
    expect(() => validateWorkflow(definition())).not.toThrow();
  });

  it('rejects an empty node list immediately', () => {
    expect(() => validateWorkflow(definition({ nodes: [] }))).toThrow(/at least one node/);
  });

  it('rejects duplicate node ids', () => {
    const error = (() => {
      try {
        validateWorkflow(definition({ nodes: [output('a'), output('a')] }));
        return null;
      } catch (thrown: unknown) {
        return thrown as WorkflowDefinitionError;
      }
    })();
    expect(error?.problems.some((problem) => problem.message.includes('Duplicate'))).toBe(true);
  });

  it('rejects an invalid input path', () => {
    const error = (() => {
      try {
        validateWorkflow(definition({ nodes: [transform('t', ['not a path'])] }));
        return null;
      } catch (thrown: unknown) {
        return thrown as WorkflowDefinitionError;
      }
    })();
    expect(
      error?.problems.some((problem) => problem.message.includes('not a valid input path')),
    ).toBe(true);
  });

  it('rejects a path listed as both required and optional', () => {
    const error = (() => {
      try {
        validateWorkflow(definition({ nodes: [transform('t', ['input.a'], ['input.a'])] }));
        return null;
      } catch (thrown: unknown) {
        return thrown as WorkflowDefinitionError;
      }
    })();
    expect(
      error?.problems.some((problem) => problem.message.includes('both required and optional')),
    ).toBe(true);
  });

  it('rejects a dangling branch target', () => {
    expect(() => validateWorkflow(definition({ nodes: [branch('b', 'missing', null)] }))).toThrow(
      /Branch target "missing" does not exist/,
    );
  });

  it('rejects a branch that points both outcomes at the same node', () => {
    expect(() =>
      validateWorkflow(definition({ nodes: [output('x'), branch('b', 'x', 'x')] })),
    ).toThrow(/no-op/);
  });

  it('detects a cycle through branch edges', () => {
    const definitionWithCycle: WorkflowDefinition = {
      version: 1,
      entryNodes: ['a'],
      nodes: [branch('a', 'b', null), branch('b', 'a', null)],
    };
    expect(() => validateWorkflow(definitionWithCycle)).toThrow(/cycle/);
  });

  it('reports an unreachable node', () => {
    const definitionWithOrphan: WorkflowDefinition = {
      version: 1,
      entryNodes: ['start'],
      nodes: [{ ...output('start'), templates: { result: 'x' } }, output('orphan')],
    };
    expect(() => validateWorkflow(definitionWithOrphan)).toThrow(/unreachable/);
  });

  it('collects multiple problems instead of failing on the first', () => {
    const error = (() => {
      try {
        validateWorkflow(
          definition({ nodes: [output('a'), output('a'), branch('b', 'nope', null)] }),
        );
        return null;
      } catch (thrown: unknown) {
        return thrown as WorkflowDefinitionError;
      }
    })();
    expect(error?.problems.length).toBeGreaterThanOrEqual(2);
  });
});
