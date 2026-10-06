/**
 * Structured parsing for workflow-decision responses.
 *
 * The workflow engine's `branch` node is deterministic on purpose: routing on a
 * value the model produced is safe, asking the model "which path next?" is not.
 * This parser produces that value. An agent node returns a decision document, a
 * later `branch` node tests `nodes.<id>.decision.decision`, and the engine picks
 * the edge — so the model classifies and the engine routes, and the same
 * decision always produces the same path.
 *
 * The vocabulary is closed. `PROCEED`, `REVISE`, `REJECT` and `ESCALATE` are the
 * only legal answers, and the schema says so, so a model that invents `RETRY`
 * fails validation and gets the one repair turn rather than silently producing a
 * branch that no edge matches.
 */
import type { JsonSchema } from '../structured.js';
import type { RepairAttempt, RepairOptions } from '../engine/structured.js';
import { parseStructuredOutput, StructuredOutputError } from '../engine/structured.js';

/** The only decisions a model may return. Closed on purpose. */
export const WORKFLOW_DECISIONS = ['PROCEED', 'REVISE', 'REJECT', 'ESCALATE'] as const;
export type WorkflowDecisionKind = (typeof WORKFLOW_DECISIONS)[number];

export const WORKFLOW_DECISION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: [...WORKFLOW_DECISIONS],
      description:
        'PROCEED to continue, REVISE for another pass, REJECT to stop, ESCALATE for a human.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the decision, from 0 (none) to 1 (certain).',
    },
    rationale: {
      type: 'string',
      description: 'One sentence explaining the decision, for the audit log.',
    },
  },
  required: ['decision', 'confidence', 'rationale'],
  additionalProperties: false,
};

export interface WorkflowDecision {
  readonly decision: WorkflowDecisionKind;
  /** Clamped to 0..1. A model reporting 1.5 meant "certain". */
  readonly confidence: number;
  readonly rationale: string;
}

export interface ParsedWorkflowDecision {
  readonly decision: WorkflowDecision;
  readonly repaired: boolean;
  readonly repair: RepairAttempt | null;
}

/**
 * Extracts, validates, and normalises a workflow-decision response.
 *
 * @throws {StructuredOutputError} when the output cannot be parsed into the
 *   schema within one repair, or names a decision outside the closed vocabulary.
 */
export async function parseWorkflowDecision(
  text: string,
  options: RepairOptions,
): Promise<ParsedWorkflowDecision> {
  const parsed = await parseStructuredOutput(text, WORKFLOW_DECISION_SCHEMA, options);
  const decision = normaliseDecision(parsed.value, text, options);

  return { decision, repaired: parsed.repaired, repair: parsed.repair };
}

/**
 * Narrows the validated document and clamps the confidence.
 *
 * The enum is re-checked here even though the schema enforces it: the schema's
 * `enum` is a wish sent to the provider and a check applied to the parsed JSON,
 * but the value is handed to a `switch` in a branch that has no default for an
 * unknown decision. Failing here names the bad value and the legal ones; failing
 * in the branch would look like a workflow definition error instead.
 */
function normaliseDecision(
  value: unknown,
  rawText: string,
  options: RepairOptions,
): WorkflowDecision {
  const record = value as Readonly<Record<string, unknown>>;
  const raw = String(record.decision).trim().toUpperCase();

  if (!(WORKFLOW_DECISIONS as readonly string[]).includes(raw)) {
    throw new StructuredOutputError(
      `Workflow decision "${raw}" is not one of ${WORKFLOW_DECISIONS.join(', ')}. ` +
        'Return the decision using one of the exact enum values.',
      [{ path: 'decision', message: `must be one of ${WORKFLOW_DECISIONS.join(', ')}` }],
      rawText,
      options.provider ?? null,
      options.model ?? null,
    );
  }

  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : 0;

  return {
    decision: raw as WorkflowDecisionKind,
    confidence,
    rationale: String(record.rationale).trim(),
  };
}

/** Type guard for consumers that hold an `unknown` decision document. */
export function isWorkflowDecision(value: unknown): value is WorkflowDecision {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.decision === 'string' &&
    (WORKFLOW_DECISIONS as readonly string[]).includes(record.decision) &&
    typeof record.confidence === 'number' &&
    typeof record.rationale === 'string'
  );
}
