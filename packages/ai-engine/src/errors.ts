/**
 * Provider error taxonomy.
 *
 * One rule decides everything downstream: **what should happen next.**
 *
 * - `retryable` means the same request to the *same* provider might succeed
 *   shortly. A 429 or a 503 is this.
 * - `failoverable` means the request itself is fine and a *different* provider
 *   should be tried. Also true of a 429, but for a different reason: the tenant's
 *   quota with that provider is exhausted, and retrying there will keep failing.
 * - neither means stop. A 401 (bad credential) or a 400 (malformed request) will
 *   fail identically on every provider and on every retry, and burning the job's
 *   retry budget on it delays the operator's signal for nothing.
 *
 * The distinction between `retryable` and `failoverable` is what makes the
 * fallback logic honest. Conflating them produces the two classic bugs: retrying
 * a 400 four times and reporting "provider error", or failing over on a transient
 * 503 when the primary was one second from recovering.
 */

/** Stable, machine-readable error codes. Persisted on `provider_attempts`. */
export const AI_ERROR_CODE = {
  /** 429, or a provider-specific quota signal. */
  RateLimited: 'RATE_LIMITED',
  /** The request exceeded the configured timeout, or the socket was aborted. */
  Timeout: 'TIMEOUT',
  /** 5xx: the provider failed, not the request. */
  ProviderUnavailable: 'PROVIDER_UNAVAILABLE',
  /** 401/403. The tenant's credential is wrong or revoked. */
  Authentication: 'AUTHENTICATION',
  /** 400/422. The request is malformed; another provider will reject it too. */
  InvalidRequest: 'INVALID_REQUEST',
  /** The model is not available to this tenant or no longer exists. */
  ModelUnavailable: 'MODEL_UNAVAILABLE',
  /** The context window was exceeded. Another provider may be larger. */
  ContextLengthExceeded: 'CONTEXT_LENGTH_EXCEEDED',
  /** The provider's safety system refused. Retrying the same text will too. */
  ContentFiltered: 'CONTENT_FILTERED',
  /** DNS failure, connection reset, TLS error. */
  NetworkError: 'NETWORK_ERROR',
  /** A response that parsed as HTTP but not as the expected shape. */
  MalformedResponse: 'MALFORMED_RESPONSE',
  /** Output was not valid JSON, or did not match the requested schema. */
  StructuredOutputInvalid: 'STRUCTURED_OUTPUT_INVALID',
  /** A workflow definition failed validation before any provider was called. */
  WorkflowInvalid: 'WORKFLOW_INVALID',
  /** The job's own retry budget is exhausted. Terminal by definition. */
  AttemptsExhausted: 'ATTEMPTS_EXHAUSTED',
} as const;
export type AiErrorCode = (typeof AI_ERROR_CODE)[keyof typeof AI_ERROR_CODE];

export interface ProviderErrorOptions {
  readonly code: AiErrorCode;
  readonly message: string;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;
  /** Milliseconds to wait, when the provider told us. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
  /** Overrides the derived defaults. See the module comment. */
  readonly retryable?: boolean;
  readonly failoverable?: boolean;
}

/**
 * How each code is handled, in one table.
 *
 * A table rather than a switch inside the classifier, so the policy is readable
 * in one screen and adding a code means adding a row rather than finding the
 * branch that handles it.
 */
const POLICY: Record<AiErrorCode, { retryable: boolean; failoverable: boolean }> = {
  // Transient and provider-scoped: the tenant's quota with this provider is
  // spent, so retrying is pointless and failing over is the whole point.
  [AI_ERROR_CODE.RateLimited]: { retryable: true, failoverable: true },
  [AI_ERROR_CODE.Timeout]: { retryable: true, failoverable: true },
  [AI_ERROR_CODE.ProviderUnavailable]: { retryable: true, failoverable: true },
  [AI_ERROR_CODE.NetworkError]: { retryable: true, failoverable: true },
  // The credential is broken. A different provider has a different credential,
  // so failing over may work — but retrying this one never will.
  [AI_ERROR_CODE.Authentication]: { retryable: false, failoverable: true },
  // The request is bad. Every provider would reject it, so neither.
  [AI_ERROR_CODE.InvalidRequest]: { retryable: false, failoverable: false },
  // This specific model is gone. Another model of the same provider may work,
  // but the router re-selects by model, not by provider, so treat it as a
  // routing failure: retryable within a fresh routing pass, not a blind retry.
  [AI_ERROR_CODE.ModelUnavailable]: { retryable: false, failoverable: true },
  // Another provider may have a bigger window, so this is exactly the case that
  // justifies per-tenant routing rather than a single global model.
  [AI_ERROR_CODE.ContextLengthExceeded]: { retryable: false, failoverable: true },
  // Deterministic on this input. Retrying re-sends the same text.
  [AI_ERROR_CODE.ContentFiltered]: { retryable: false, failoverable: false },
  // Our bug or the provider's contract drift. Retrying gets the same bytes.
  [AI_ERROR_CODE.MalformedResponse]: { retryable: false, failoverable: false },
  // The engine's own one-shot repair already ran and failed. Not the provider's
  // fault, so another provider would produce equally unparseable text.
  [AI_ERROR_CODE.StructuredOutputInvalid]: { retryable: false, failoverable: false },
  // A definition error. Fixable in code, not by waiting.
  [AI_ERROR_CODE.WorkflowInvalid]: { retryable: false, failoverable: false },
  [AI_ERROR_CODE.AttemptsExhausted]: { retryable: false, failoverable: false },
};

export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** Whether to try the same provider again. */
  readonly retryable: boolean;
  /** Whether to try a different provider. */
  readonly failoverable: boolean;

  constructor(options: ProviderErrorOptions) {
    const policy = POLICY[options.code];
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiProviderError';
    this.code = options.code;
    this.provider = options.provider ?? null;
    this.model = options.model ?? null;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? policy.retryable;
    this.failoverable = options.failoverable ?? policy.failoverable;
  }

  /** A compact, log-safe rendering. Never includes the request body. */
  describe(): string {
    const parts: string[] = [this.code];
    if (this.provider !== null) parts.push(`provider=${this.provider}`);
    if (this.model !== null) parts.push(`model=${this.model}`);
    if (this.status !== null) parts.push(`status=${this.status}`);
    if (this.retryAfterMs !== null) parts.push(`retryAfter=${this.retryAfterMs}ms`);
    return `${parts.join(' ')}: ${this.message}`;
  }
}

/**
 * Maps an HTTP status to a code.
 *
 * 429 first, then the 5xx range, then 401/403, then everything else. The order is
 * not arbitrary: 429 sits inside the 4xx range and would be swallowed by the
 * generic branch, and a rate limit is the single most important case to get
 * right.
 */
export function codeForStatus(status: number): AiErrorCode {
  if (status === 429) return AI_ERROR_CODE.RateLimited;
  if (status === 401 || status === 403) return AI_ERROR_CODE.Authentication;
  if (status === 408) return AI_ERROR_CODE.Timeout;
  if (status === 413) return AI_ERROR_CODE.ContextLengthExceeded;
  if (status >= 500) return AI_ERROR_CODE.ProviderUnavailable;
  if (status >= 400) return AI_ERROR_CODE.InvalidRequest;
  // A 3xx we did not follow, or a 2xx on a request that expected an error.
  return AI_ERROR_CODE.MalformedResponse;
}

/**
 * Reads `Retry-After` in either of its two legal forms.
 *
 * Seconds, or an HTTP date. Returns null when absent or unparseable — an
 * unparseable value is not treated as "wait forever", because a provider sending
 * garbage should not be able to stall a worker's whole concurrency.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null;

  const trimmed = header.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;

  // A date already in the past means "retry now", not "retry in the negative".
  return Math.max(0, date - now);
}
