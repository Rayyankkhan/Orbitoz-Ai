/**
 * The per-provider token bucket and registry.
 *
 * Time is injected, so these tests advance a virtual clock instead of waiting a
 * real minute.
 */
import { describe, expect, it } from 'vitest';
import { RateLimiterRegistry, TokenBucket } from './rate-limit.js';
import { AI_ERROR_CODE } from '../errors.js';

describe('TokenBucket', () => {
  it('admits up to capacity then refuses', () => {
    const bucket = new TokenBucket(2, 1 / 1_000, 0);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
  });

  it('refills over elapsed time', () => {
    const bucket = new TokenBucket(1, 1 / 1_000, 0);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(500)).toBe(false);
    expect(bucket.tryTake(1_000)).toBe(true);
  });

  it('never refills on a backwards clock', () => {
    // A backwards NTP step must not refill the bucket to capacity.
    const bucket = new TokenBucket(1, 1 / 1_000, 10_000);
    expect(bucket.tryTake(10_000)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
  });

  it('reports the wait until the next token', () => {
    const bucket = new TokenBucket(1, 1 / 1_000, 0);
    bucket.tryTake(0);
    expect(bucket.waitMs(0)).toBe(1_000);
    expect(bucket.waitMs(1_000)).toBe(0);
  });

  it('caps tokens at capacity regardless of elapsed time', () => {
    const bucket = new TokenBucket(1, 1 / 1_000, 0);
    expect(bucket.available(1_000_000)).toBe(1);
  });
});

describe('RateLimiterRegistry', () => {
  const limits = { OPENAI: { requests: 2, windowMs: 1_000 } };

  it('always admits a provider with no configured limit', () => {
    const registry = new RateLimiterRegistry(limits, () => 0);
    expect(registry.tryAcquire('UNCONFIGURED')).toBe(true);
    expect(registry.acquireOrThrow('UNCONFIGURED')).toBeUndefined();
  });

  it('throws a rate-limited error with a wait time once the bucket is empty', () => {
    const registry = new RateLimiterRegistry(limits, () => 0);
    expect(registry.tryAcquire('OPENAI')).toBe(true);
    expect(registry.tryAcquire('OPENAI')).toBe(true);
    expect(registry.tryAcquire('OPENAI')).toBe(false);

    let thrown: unknown;
    try {
      registry.acquireOrThrow('OPENAI', 'gpt-4o');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: AI_ERROR_CODE.RateLimited,
      provider: 'OPENAI',
      model: 'gpt-4o',
    });
    expect((thrown as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it('keys buckets by provider, not by model', () => {
    const registry = new RateLimiterRegistry({ OPENAI: { requests: 1, windowMs: 1_000 } }, () => 0);
    expect(registry.tryAcquire('OPENAI')).toBe(true);
    // A second model on the same provider shares the key's bucket.
    expect(registry.tryAcquire('OPENAI')).toBe(false);
  });
});
