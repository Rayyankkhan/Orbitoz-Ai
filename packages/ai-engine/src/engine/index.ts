/**
 * Orchestration primitives: failover, rate limiting, structured-output repair.
 *
 * A separate entry point from the package root because a caller that only wants
 * "one request, several providers" should not pull in the workflow executor. The
 * split also keeps the dependency direction clean — `engine/` knows nothing about
 * `workflow/`.
 */

export {
  executeWithFailover,
  toProviderError,
  type EngineOutcome,
  type EngineRequest,
} from './executor.js';

export {
  DEFAULT_RATE_LIMITS,
  RateLimiterRegistry,
  TokenBucket,
  type RateLimitOptions,
} from './rate-limit.js';

export {
  buildRepairPrompt,
  formatViolations,
  parseStructuredOutput,
  schemaInstructions,
  StructuredOutputError,
  tryParse,
  MAX_QUOTED_TEXT,
  type ParseOptions,
  type RepairAttempt,
  type RepairOptions,
  type StructuredParseResult,
} from './structured.js';
