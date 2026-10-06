/**
 * DLQ routing decisions — the unit tests.
 *
 * `decideDeadLetter` is the whole retry/DLQ policy, and it is pure, so it is
 * tested here rather than through a Redis round trip. What the routing *does* to
 * Redis is proven in `test/dlq-routing.integration.test.ts`.
 *
 * The cases that matter are the ones where the naive implementation is wrong:
 * routing before the retry budget is spent (double-charging a retry), routing
 * every failure regardless of reason (a poison payload cycling four times), and
 * routing a job with no tenant id into an arbitrary namespace.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB_OPTIONS, DLQ_REASON } from '@orbitoz/shared-types';
import { decideDeadLetter } from './dead-letter.js';
import { JobContextError } from '../context/job-context.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ATTEMPTS = DEFAULT_JOB_OPTIONS.attempts;

function job(overrides: { attemptsMade?: number; tenantId?: unknown; attempts?: number } = {}) {
  return {
    // `'tenantId' in overrides` rather than `?? TENANT`: several cases below pass
    // `null` and `undefined` deliberately, and `??` would quietly substitute a
    // valid tenant and assert the opposite of what the case is about.
    data: { tenantId: 'tenantId' in overrides ? overrides.tenantId : TENANT },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? ATTEMPTS },
  };
}

describe('decideDeadLetter', () => {
  it('does not dead-letter while retries remain', () => {
    // The most important negative case: routing early would remove the job from
    // the retry cycle it still has left.
    for (let attemptsMade = 1; attemptsMade < ATTEMPTS; attemptsMade += 1) {
      expect(decideDeadLetter(job({ attemptsMade }), new Error('503'))).toEqual({
        shouldDeadLetter: false,
        reason: null,
      });
    }
  });

  it('dead-letters once the retry budget is exhausted', () => {
    expect(decideDeadLetter(job({ attemptsMade: ATTEMPTS }), new Error('503'))).toEqual({
      shouldDeadLetter: true,
      reason: DLQ_REASON.Exhausted,
    });
  });

  it('dead-letters a non-retryable failure immediately, skipping the budget', () => {
    // Four attempts on a poison payload delays the DLQ signal by seven seconds and
    // produces four identical log lines to diagnose.
    const poison = new JobContextError(['tenantId must be a non-empty string']);
    expect(decideDeadLetter(job({ attemptsMade: 1 }), poison)).toEqual({
      shouldDeadLetter: true,
      reason: DLQ_REASON.NonRetryable,
    });
  });

  it('honours an explicit retryable: false on the first attempt', () => {
    const error = Object.assign(new Error('model not in plan'), { retryable: false });
    expect(decideDeadLetter(job({ attemptsMade: 1 }), error).reason).toBe(DLQ_REASON.NonRetryable);
  });

  it('refuses to dead-letter a payload with no tenant id', () => {
    // There is no namespace to file it under. Putting an unattributable job in
    // some arbitrary tenant's DLQ would be a lie about where it came from.
    for (const tenantId of [undefined, null, '', 42]) {
      expect(decideDeadLetter(job({ tenantId, attemptsMade: 99 }), new Error('x'))).toEqual({
        shouldDeadLetter: false,
        reason: null,
      });
    }
  });

  it('falls back to the default budget when a job carries no attempts option', () => {
    const bare = { data: { tenantId: TENANT }, attemptsMade: ATTEMPTS, opts: {} };
    expect(decideDeadLetter(bare, new Error('x')).shouldDeadLetter).toBe(true);

    const notYet = { data: { tenantId: TENANT }, attemptsMade: ATTEMPTS - 1, opts: {} };
    expect(decideDeadLetter(notYet, new Error('x')).shouldDeadLetter).toBe(false);
  });

  it('respects a per-job attempt override', () => {
    // A job given more attempts than the default must not be dead-lettered at the
    // default's threshold.
    const wider = job({ attemptsMade: ATTEMPTS, attempts: 6 });
    expect(decideDeadLetter(wider, new Error('x')).shouldDeadLetter).toBe(false);
  });

  it('treats a single-attempt job as immediately dead-lettered on failure', () => {
    expect(decideDeadLetter(job({ attempts: 1, attemptsMade: 1 }), new Error('x'))).toEqual({
      shouldDeadLetter: true,
      reason: DLQ_REASON.Exhausted,
    });
  });

  it('still dead-letters a malformed payload when it has a tenant id', () => {
    // The tenant id alone is enough to pick a namespace; the rest of the envelope
    // being broken does not change where the job came from.
    const result = decideDeadLetter(
      { data: { tenantId: TENANT }, attemptsMade: 1, opts: { attempts: 4 } },
      new JobContextError(['traceId missing']),
    );
    expect(result).toEqual({ shouldDeadLetter: true, reason: DLQ_REASON.NonRetryable });
  });
});
