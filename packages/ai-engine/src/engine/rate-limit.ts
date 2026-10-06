/**
 * Per-provider rate limiting.
 *
 * Why the engine needs its own limiter rather than relying on provider 429s:
 * a worker's retry budget is *per job*, and several jobs retry independently. Four
 * concurrent jobs hitting a provider with a 60-requests-per-minute limit produce
 * 240 requests a minute, get 429s, and each burns its own backoff — so the retry
 * storm the backoff was meant to dampen is *caused* by the retries. A limiter
 * smooths arrivals before the provider has to reject them.
 *
 * It also protects against spending money on a 429 that carries no charge but does
 * consume the tenant's quota, pushing their legitimate traffic out.
 *
 * **Process-local, and that is an honest limitation.** Each worker process has its
 * own limiters, so N processes admit up to N× the configured rate. A shared limit
 * needs Redis, which means an await on the hot path and a dependency this package
 * deliberately does not have — it is pure and testable, and the worker passes in
 * whatever limiter it can afford. Documented rather than hidden: a limit that
 * appears to be global and is not will cause a rate-limit incident to be
 * misdiagnosed as a provider problem.
 */
import { AiProviderError, AI_ERROR_CODE } from '../errors.js';

export interface RateLimitOptions {
  /** Sustained requests per window. */
  readonly requests: number;
  readonly windowMs: number;
}

/** One sliding-window bucket. */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  /**
   * Takes one token if available.
   *
   * Non-blocking by design: the caller decides whether to wait or fail over. A
   * blocking `acquire()` here would make a 429 from our own limiter
   * indistinguishable from a provider outage to the retry layer.
   */
  tryTake(nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until one whole token exists. Zero if one is available now. */
  waitMs(nowMs: number): number {
    this.refill(nowMs);
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /** Tokens available now, for metrics. */
  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }

  private refill(nowMs: number): void {
    // A clock that went backwards (NTP step, VM suspend) would otherwise produce a
    // negative elapsed time and permanently refill the bucket to capacity.
    const elapsed = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsed === 0) return;

    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = nowMs;
  }
}

/**
 * A set of per-provider buckets.
 *
 * Keyed by provider rather than by model because the limit belongs to the API key,
 * and one key serves every model that provider offers. Keying by model would let a
 * tenant's three OpenAI models each admit the full limit and hit the ceiling three
 * times over.
 */
export class RateLimiterRegistry {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly limits: Readonly<Record<string, RateLimitOptions>>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Attempts to admit one request for a provider.
   *
   * Unconfigured providers are always admitted. The engine's job is to honour
   * limits it was told about; inventing a default would silently throttle a
   * provider whose real limit is far higher, and the symptom — unexplained latency
   * — points nowhere near the cause.
   */
  tryAcquire(provider: string): boolean {
    const bucket = this.bucketFor(provider);
    return bucket === null ? true : bucket.tryTake(this.now());
  }

  /**
   * Throws when the provider is over its limit.
   *
   * @throws {AiProviderError} `RateLimited`, carrying the wait in `retryAfterMs` so
   * the retry layer's backoff picks it up instead of inventing its own delay.
   */
  acquireOrThrow(provider: string, model?: string): void {
    const bucket = this.bucketFor(provider);
    if (bucket === null) return;

    if (bucket.tryTake(this.now())) return;

    const waitMs = bucket.waitMs(this.now());
    throw new AiProviderError({
      code: AI_ERROR_CODE.RateLimited,
      message: `Local rate limit reached for ${provider}. Next request may proceed in ${waitMs}ms.`,
      provider,
      ...(model === undefined ? {} : { model }),
      retryAfterMs: waitMs,
    });
  }

  waitMs(provider: string): number {
    return this.bucketFor(provider)?.waitMs(this.now()) ?? 0;
  }

  private bucketFor(provider: string): TokenBucket | null {
    const existing = this.buckets.get(provider);
    if (existing !== undefined) return existing;

    const limit = this.limits[provider];
    if (limit === undefined) return null;

    // Capacity equals the burst ceiling and the refill rate equals
    // `requests / windowMs`, which makes the bucket's sustained rate exactly the
    // configured one while still allowing a full window's worth of burst.
    const created = new TokenBucket(limit.requests, limit.requests / limit.windowMs, this.now());
    this.buckets.set(provider, created);
    return created;
  }
}

/**
 * Default limits, from provider documentation.
 *
 * Conservative on purpose. These are the *published* rates for a standard tier, and
 * a tenant on a higher tier is simply under-throttled — which costs latency, not
 * correctness. The reverse error, exceeding a real limit, costs 429s and quota.
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<string, RateLimitOptions>> = {
  OPENAI: { requests: 500, windowMs: 60_000 },
  ANTHROPIC: { requests: 1_000, windowMs: 60_000 },
  MISTRAL: { requests: 60, windowMs: 60_000 },
  GOOGLE: { requests: 300, windowMs: 60_000 },
};
