/**
 * Backoff, retry, and their interaction with `Retry-After`.
 *
 * Time is injected everywhere, so these tests assert on delay *bounds* and call
 * counts instead of sleeping. A retry test that waits in real time is the slowest
 * test in the suite and the first to go flaky in CI.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  nextDelayMs,
  shouldRetry,
  withRetry,
  type BackoffOptions,
} from './backoff.js';
import { AI_ERROR_CODE, AiProviderError } from './errors.js';

const OPTIONS: BackoffOptions = { baseDelayMs: 100, maxDelayMs: 10_000, retries: 3 };

describe('backoffDelayMs', () => {
  it('grows exponentially but never exceeds the cap', () => {
    const random = () => 1;
    expect(backoffDelayMs(0, { ...OPTIONS, random })).toBe(100);
    expect(backoffDelayMs(1, { ...OPTIONS, random })).toBe(200);
    expect(backoffDelayMs(2, { ...OPTIONS, random })).toBe(400);

    const capped = backoffDelayMs(20, { ...OPTIONS, random });
    expect(capped).toBe(10_000);
  });

  it('stays within [0, capped] for arbitrary randomness (full jitter)', () => {
    expect(backoffDelayMs(5, { ...OPTIONS, random: () => 0 })).toBe(0);
  });
});

describe('shouldRetry', () => {
  it('retries a retryable error while the budget remains', () => {
    const error = new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'x' });
    expect(shouldRetry(error, 0, OPTIONS)).toBe(true);
    expect(shouldRetry(error, 2, OPTIONS)).toBe(true);
  });

  it('stops retrying once the budget is spent', () => {
    const error = new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'x' });
    expect(shouldRetry(error, 3, OPTIONS)).toBe(false);
  });

  it('never retries a non-retryable error', () => {
    const error = new AiProviderError({ code: AI_ERROR_CODE.InvalidRequest, message: 'x' });
    expect(shouldRetry(error, 0, OPTIONS)).toBe(false);
  });
});

describe('nextDelayMs', () => {
  it('honours a provider Retry-After, capped at maxDelay', () => {
    const error = new AiProviderError({
      code: AI_ERROR_CODE.RateLimited,
      message: 'x',
      retryAfterMs: 5_000,
    });
    expect(nextDelayMs(error, 0, OPTIONS)).toBe(5_000);

    const absurd = new AiProviderError({
      code: AI_ERROR_CODE.RateLimited,
      message: 'x',
      retryAfterMs: 3_600_000,
    });
    expect(nextDelayMs(absurd, 0, OPTIONS)).toBe(10_000);
  });

  it('falls back to computed backoff with no Retry-After', () => {
    const error = new AiProviderError({ code: AI_ERROR_CODE.ProviderUnavailable, message: 'x' });
    expect(nextDelayMs(error, 0, { ...OPTIONS, random: () => 1 })).toBe(100);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const operation = vi.fn(() => Promise.resolve('ok'));
    const sleep = vi.fn(() => Promise.resolve());

    await expect(withRetry(operation, { ...OPTIONS, sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable failure and returns the eventual success', async () => {
    let calls = 0;
    const operation = vi.fn(() => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(
          new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'nope' }),
        );
      }
      return Promise.resolve('finally');
    });
    const sleep = vi.fn(() => Promise.resolve());

    await expect(withRetry(operation, { ...OPTIONS, sleep })).resolves.toBe('finally');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-retryable failure immediately', async () => {
    const operation = vi.fn(() =>
      Promise.reject(new AiProviderError({ code: AI_ERROR_CODE.InvalidRequest, message: 'bad' })),
    );
    const sleep = vi.fn(() => Promise.resolve());

    await expect(withRetry(operation, { ...OPTIONS, sleep })).rejects.toMatchObject({
      code: AI_ERROR_CODE.InvalidRequest,
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('throws the last error, so the DLQ names the final cause', async () => {
    let calls = 0;
    const operation = vi.fn(() => {
      calls += 1;
      return Promise.reject(
        new AiProviderError({
          code: AI_ERROR_CODE.RateLimited,
          message: `failure ${calls}`,
        }),
      );
    });

    const error = await withRetry(operation, { ...OPTIONS, sleep: () => Promise.resolve() }).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as AiProviderError).message).toBe('failure 4');
  });

  it('defaults to the documented budget and jitter', () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseDelayMs: 500, maxDelayMs: 30_000, retries: 3 });
  });
});
