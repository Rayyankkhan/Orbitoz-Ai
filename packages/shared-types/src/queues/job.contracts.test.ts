import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, WORKER_QUEUES } from '@orbitoz/shared-types';
import { DEAD_LETTER_JOB_OPTIONS, DEFAULT_JOB_OPTIONS, DLQ_REASON } from '@orbitoz/shared-types';

/**
 * The queue contract, as the gateway and the worker both read it.
 *
 * These assertions exist because every other guarantee in this module rests on
 * them. If `WORKER_QUEUES` quietly grew a queue nobody implemented, the worker
 * would subscribe and fail every job with "no processor registered" — a failure
 * that only appears in production, on a queue nobody was watching. If the retry
 * budget changed, the DLQ tests would still pass while the operational numbers
 * in the docs quietly went stale.
 */
describe('queue contract', () => {
  it('consumes exactly the four job queues the processors implement', () => {
    expect([...WORKER_QUEUES]).toEqual([
      QUEUE_NAMES.AiInference,
      QUEUE_NAMES.UsageAggregation,
      QUEUE_NAMES.TenantProvisioning,
      QUEUE_NAMES.NotificationDispatch,
    ]);
  });

  it('does not consume its own dead letter queue', () => {
    // Otherwise a DLQ entry would be picked up as a job, fail again, and be
    // dead-lettered a second time — an infinite loop on one poison entry.
    expect(WORKER_QUEUES).not.toContain(QUEUE_NAMES.DeadLetter);
  });

  it('names every queue without a colon, since BullMQ rejects those', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name).not.toContain(':');
    }
  });

  it('gives every job four attempts with exponential backoff from 1s', () => {
    // One initial attempt plus three retries at 1s, 2s, 4s. The docs quote these
    // numbers to an operator deciding how long to wait; changing them here without
    // changing the docs would make the docs a guess.
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(4);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: 1_000,
      // Jitter randomises each retry by ±50%. Without it, a provider blip that
      // takes down a hundred tenants fails all hundred workflows on the same
      // schedule and retries them in lockstep — the thundering herd the backoff
      // exists to prevent. The documented schedule is therefore approximate: the
      // third retry lands somewhere in 2s–6s, not exactly 4s.
      jitter: 0.5,
    });
  });

  it('gives DLQ jobs a single attempt and keeps them for inspection', () => {
    expect(DEAD_LETTER_JOB_OPTIONS.attempts).toBe(1);
    // A DLQ entry trimmed by `removeOnFail` could vanish before an operator saw it,
    // which is the one thing the DLQ is for.
    expect(DEAD_LETTER_JOB_OPTIONS.removeOnFail).toBe(false);
  });

  it('distinguishes an exhausted budget from a failure that will never succeed', () => {
    // The distinction is what tells an operator whether to wait or to fix
    // something, so it cannot collapse into one generic reason.
    expect(DLQ_REASON.Exhausted).not.toBe(DLQ_REASON.NonRetryable);
  });
});
