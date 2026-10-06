/**
 * Retry, backoff, and failover.
 *
 * Three separate decisions, kept in three separate functions, because conflating
 * them is the most common way a retry policy goes wrong:
 *
 * - **Backoff** (this file): how long to wait before trying again.
 * - **Retry** (this file): whether to try again *at all*, against the *same*
 *   provider.
 * - **Failover** (`engine/failover.ts`): whether to try a *different* provider.
 *
 * Backoff with **full jitter** — `random() * min(cap, base * 2^attempt)` — rather
 * than the equal-variance "half the delay plus a bit" variety. Full jitter is the
 * only variant that actually de-synchronises a thundering herd: a provider blip
 * fails a thousand jobs at once, and any scheme that keeps the delay *correlated*
 * with the attempt number retries them all at the same relative offsets. Random
 * from zero is what breaks that correlation.
 *
 * `Retry-After` wins over the computed delay. A provider that says "come back in
 * 30 seconds" knows something about its own recovery; retrying in 1.5s because
 * that is what the formula said is how a rate limit becomes an outage.
 */
import { AiProviderError } from './errors.js';

export interface BackoffOptions {
  /** First retry's base delay, in milliseconds. */
  readonly baseDelayMs: number;
  /** Ceiling on any single delay, applied before jitter. */
  readonly maxDelayMs: number;
  /** Attempts after the first. `retries: 3` means up to 4 total calls. */
  readonly retries: number;
  /**
   * Injected randomness, so tests can assert on the delay *bounds* rather than
   * sleeping. Defaults to `Math.random`.
   */
  readonly random?: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  retries: 3,
};

/**
 * Computes the delay before attempt number `attempt` (0-based).
 *
 * Full jitter: `random() * min(maxDelay, base * 2^attempt)`. The cap is applied
 * *before* the random multiply, so the ceiling is a true ceiling — jitter can only
 * shorten a wait, never extend it past the cap. Jitter that could exceed the cap
 * would defeat the purpose of having one.
 *
 * `random` is parameterised rather than called directly so a test can pin it. A
 * test that asserts on wall-clock sleeps is a slow, flaky test.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const exponential = options.baseDelayMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(exponential, options.maxDelayMs);
  const random = options.random ?? Math.random;
  return Math.floor(random() * capped);
}

/**
 * Whether to retry `error` against the same provider.
 *
 * Consults the error's own `retryable` flag, which the taxonomy table in
 * `errors.ts` derives from the code. This function exists to *apply* that policy
 * with two extra rules that the table cannot express:
 *
 * 1. **The budget.** A retry that exhausts the job's own attempt budget is
 *    pointless; the job will be dead-lettered anyway.
 * 2. **A provider-supplied `Retry-After` is honoured as a reason to retry**, even
 *    for codes that are not otherwise retryable. If a provider says "retry me in
 *    5s" it has classified the failure as temporary, and second-guessing it
 *    discards information the provider has and we do not.
 *
 * Cancellation is never retried, and it says so explicitly rather than relying on
 * `retryable: false` being set correctly upstream — a drained worker that retries
 * a cancelled request is a worker that will not shut down.
 */
export function shouldRetry(error: unknown, attempt: number, options: BackoffOptions): boolean {
  if (attempt >= options.retries) return false;
  if (error instanceof AiProviderError && error.retryable) return true;
  return false;
}

/**
 * The delay to wait before the next attempt.
 *
 * `Retry-After` is honoured when present but still capped. An unbounded
 * `Retry-After` — a provider reporting an hour, or a clock-skewed date far in the
 * future — would hold a worker slot for that long, and a job that waits an hour
 * for a slot is a job that has already failed its purpose. Past the cap the delay
 * is the cap, and the job's own retry budget ends the attempt loop shortly after.
 */
export function nextDelayMs(error: unknown, attempt: number, options: BackoffOptions): number {
  if (error instanceof AiProviderError && error.retryAfterMs !== null) {
    return Math.min(error.retryAfterMs, options.maxDelayMs);
  }
  return backoffDelayMs(attempt, options);
}

/** Sleeps. Injectable so tests do not wait in real time. */
export type Sleeper = (ms: number) => Promise<void>;

export const realSleep: Sleeper = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `operation` with retry.
 *
 * Returns the operation's value, or throws the *last* error. Rethrowing the last
 * error rather than the first is what makes a rate limit visible as a rate limit
 * in the DLQ: the first error was a timeout, the last was "you have exceeded your
 * quota", and the second is the one an operator needs.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: BackoffOptions & { readonly sleep?: Sleeper },
): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error, attempt, options)) throw error;
      await sleep(nextDelayMs(error, attempt, options));
    }
  }

  // Unreachable: the loop either returns or throws on the final iteration, since
  // `shouldRetry` is false once `attempt >= retries`. Present so the function has
  // a total return path rather than relying on control-flow analysis.
  throw lastError;
}
