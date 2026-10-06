/**
 * The workflow-decision parser.
 *
 * The decision is a closed enum because a `branch` node switches on it with no
 * default edge. A model that returns `RETRY`, or `proceed` in the wrong case, must
 * be normalised or rejected *here*, where the failure names the legal values,
 * rather than downstream where it would look like a malformed workflow graph.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isWorkflowDecision,
  parseWorkflowDecision,
  WORKFLOW_DECISION_SCHEMA,
  WORKFLOW_DECISIONS,
} from './decision.js';
import type { RepairOptions } from '../engine/structured.js';

const VALID = JSON.stringify({
  decision: 'PROCEED',
  confidence: 0.82,
  rationale: 'The draft meets the brief.',
});

const NO_REPAIR: RepairOptions = {
  repair: () => Promise.reject(new Error('repair should not have been called')),
};

describe('parseWorkflowDecision', () => {
  it('parses a valid decision', async () => {
    const result = await parseWorkflowDecision(VALID, NO_REPAIR);

    expect(result.repaired).toBe(false);
    expect(result.decision).toEqual({
      decision: 'PROCEED',
      confidence: 0.82,
      rationale: 'The draft meets the brief.',
    });
  });

  it('treats a wrong-case decision as invalid and spends the repair turn', async () => {
    // The schema enum is upper-case, so `revise` fails validation before the
    // normaliser's upper-casing can help. Documented as a repair rather than a
    // silent accept: the repair prompt tells the model the exact enum values.
    const repair = vi.fn(() =>
      Promise.resolve({
        text: JSON.stringify({ decision: 'REVISE', confidence: 0.5, rationale: 'Needs work.' }),
        inputTokens: 0,
        outputTokens: 0,
        costUsdMicros: 0,
      }),
    );
    const raw = JSON.stringify({ decision: 'revise', confidence: 0.5, rationale: 'Needs work.' });

    const result = await parseWorkflowDecision(raw, { repair });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(true);
    expect(result.decision.decision).toBe('REVISE');
  });

  it('clamps a confidence above 1 rather than rejecting it', async () => {
    // A model that says 1.5 meant "certain"; failing the job over arithmetic it
    // cannot do would be pedantic.
    const raw = JSON.stringify({ decision: 'PROCEED', confidence: 1.5, rationale: 'Sure.' });
    const result = await parseWorkflowDecision(raw, NO_REPAIR);

    expect(result.decision.confidence).toBe(1);
  });

  it('clamps a negative confidence to 0', async () => {
    const raw = JSON.stringify({ decision: 'REJECT', confidence: -0.3, rationale: 'No.' });
    const result = await parseWorkflowDecision(raw, NO_REPAIR);

    expect(result.decision.confidence).toBe(0);
  });

  it('repairs once when the decision is outside the vocabulary', async () => {
    const repair = vi.fn(() =>
      Promise.resolve({ text: VALID, inputTokens: 0, outputTokens: 0, costUsdMicros: 0 }),
    );
    const invalid = JSON.stringify({ decision: 'RETRY', confidence: 0.5, rationale: 'x' });

    const result = await parseWorkflowDecision(invalid, { repair });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(true);
    expect(result.decision.decision).toBe('PROCEED');
  });

  it('fails when the decision is still outside the vocabulary after repair', async () => {
    const invalid = JSON.stringify({ decision: 'RETRY', confidence: 0.5, rationale: 'x' });

    await expect(
      parseWorkflowDecision(invalid, { repair: () => Promise.resolve({ text: invalid }) }),
    ).rejects.toThrow(/RETRY/);
  });

  it('exposes the closed vocabulary to the schema and to callers', () => {
    const decisionProperty = WORKFLOW_DECISION_SCHEMA.properties.decision as {
      enum?: readonly string[];
    };
    expect(decisionProperty.enum).toEqual([...WORKFLOW_DECISIONS]);
    expect(WORKFLOW_DECISION_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('isWorkflowDecision', () => {
  it('accepts a well-formed decision document', () => {
    expect(
      isWorkflowDecision({ decision: 'ESCALATE', confidence: 0.2, rationale: 'Human needed.' }),
    ).toBe(true);
  });

  it('rejects an unknown decision', () => {
    expect(isWorkflowDecision({ decision: 'RETRY', confidence: 0.2, rationale: 'x' })).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(isWorkflowDecision(null)).toBe(false);
    expect(isWorkflowDecision('PROCEED')).toBe(false);
  });
});
