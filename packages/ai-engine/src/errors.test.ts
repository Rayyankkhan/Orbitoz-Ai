/**
 * The error taxonomy and HTTP status mapping.
 *
 * The mapping is the single decision that drives retry and failover, so it is
 * worth testing directly rather than only through a provider. The 429-inside-4xx
 * ordering in particular is a bug waiting to be reintroduced.
 */
import { describe, expect, it } from 'vitest';
import { AI_ERROR_CODE, AiProviderError, codeForStatus, parseRetryAfter } from './errors.js';

describe('codeForStatus', () => {
  it('maps 429 to rate limited before the generic 4xx branch', () => {
    expect(codeForStatus(429)).toBe(AI_ERROR_CODE.RateLimited);
  });

  it('maps 5xx to provider unavailable', () => {
    expect(codeForStatus(500)).toBe(AI_ERROR_CODE.ProviderUnavailable);
    expect(codeForStatus(503)).toBe(AI_ERROR_CODE.ProviderUnavailable);
  });

  it('maps 401 and 403 to authentication', () => {
    expect(codeForStatus(401)).toBe(AI_ERROR_CODE.Authentication);
    expect(codeForStatus(403)).toBe(AI_ERROR_CODE.Authentication);
  });

  it('maps 413 to context length exceeded', () => {
    expect(codeForStatus(413)).toBe(AI_ERROR_CODE.ContextLengthExceeded);
  });

  it('maps 408 to timeout', () => {
    expect(codeForStatus(408)).toBe(AI_ERROR_CODE.Timeout);
  });

  it('maps other 4xx to invalid request', () => {
    expect(codeForStatus(400)).toBe(AI_ERROR_CODE.InvalidRequest);
    expect(codeForStatus(422)).toBe(AI_ERROR_CODE.InvalidRequest);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds into milliseconds', () => {
    expect(parseRetryAfter('3')).toBe(3_000);
  });

  it('returns null for an absent or empty header', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
  });

  it('parses an HTTP date into a non-negative delay', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
  });

  it('clamps a date in the past to zero rather than going negative', () => {
    const now = Date.parse('2026-01-01T00:00:10Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('returns null for garbage instead of stalling forever', () => {
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('AiProviderError', () => {
  it('derives retryable and failoverable from the code', () => {
    const rateLimited = new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'x' });
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.failoverable).toBe(true);

    const invalid = new AiProviderError({ code: AI_ERROR_CODE.InvalidRequest, message: 'x' });
    expect(invalid.retryable).toBe(false);
    expect(invalid.failoverable).toBe(false);

    // A broken credential is not worth retrying but is worth failing over: a
    // different provider has a different credential.
    const auth = new AiProviderError({ code: AI_ERROR_CODE.Authentication, message: 'x' });
    expect(auth.retryable).toBe(false);
    expect(auth.failoverable).toBe(true);
  });

  it('lets the caller override the derived policy', () => {
    const error = new AiProviderError({
      code: AI_ERROR_CODE.InvalidRequest,
      message: 'x',
      failoverable: true,
    });
    expect(error.failoverable).toBe(true);
  });

  it('renders a log-safe description without any request body', () => {
    const error = new AiProviderError({
      code: AI_ERROR_CODE.RateLimited,
      message: 'quota exceeded',
      provider: 'OPENAI',
      model: 'gpt-4o',
      status: 429,
      retryAfterMs: 3_000,
    });
    expect(error.describe()).toBe(
      'RATE_LIMITED provider=OPENAI model=gpt-4o status=429 retryAfter=3000ms: quota exceeded',
    );
  });
});
