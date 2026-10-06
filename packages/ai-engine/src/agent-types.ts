/**
 * Types describing the result of one agent call.
 *
 * Separate from both the provider contracts and the workflow types because both
 * layers need them: the failover engine produces one, and the workflow engine
 * carries it into the run result. Putting them in either would make the other
 * import across a boundary it has no business crossing — `engine/` and `workflow/`
 * are independent layers that happen to agree on this vocabulary.
 */
import type { FinishReason } from './providers/contracts.js';

/** One provider call, successful or not. */
export interface AgentAttempt {
  readonly provider: string;
  readonly model: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/** A completed agent call, with everything needed to bill and audit it. */
export interface AgentResult {
  /** Raw model output, before any structured parsing. */
  readonly text: string;
  /**
   * Why the model stopped.
   *
   * Carried out of the provider layer because a `length` stop is the difference
   * between "the model refused" and "we cut it off" — the caller persists this so
   * a truncated answer is not mistaken for a complete one.
   */
  readonly finishReason: FinishReason;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Integer micro-USD. Integer because float money accrues drift. */
  readonly costUsdMicros: number;
  readonly latencyMs: number;
  /**
   * Parsed and schema-validated output, when the node requested structured output.
   *
   * `unknown` already admits `null`, and `null` is the meaningful value when a
   * node ran free-text: the caller checks for it rather than reading a field that
   * would not exist. Written as plain `unknown` so the redundant-union lint does
   * not fire on what is, in effect, the same type.
   */
  readonly structured: unknown;
  /** Failed attempts that preceded this success. The audit trail. */
  readonly attempts: readonly AgentAttempt[];
}
