/**
 * Job context — the unit tests.
 *
 * The claim under test is that a worker never guesses a tenant. Context comes
 * from the envelope, a missing field fails loudly rather than defaulting, and
 * the ambient scope that every downstream query reads is established exactly
 * once per job.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { currentTenantScope } from '@orbitoz/database';
import type { BaseJob, TenantId, UserId } from '@orbitoz/shared-types';
import { JobContextError, isRetryable, jobContextOf, withJobContext } from './job-context.js';

const TENANT = '11111111-1111-4111-8111-111111111111' as TenantId;
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222' as TenantId;

function jobWith(data: unknown, attempts = 1): Job<BaseJob<unknown>> {
  return {
    id: 'job-1',
    name: 'test.job',
    data,
    attemptsMade: attempts,
    opts: {},
  } as unknown as Job<BaseJob<unknown>>;
}

function validEnvelope(overrides: Record<string, unknown> = {}): BaseJob<unknown> {
  return {
    id: 'job-1',
    tenantId: TENANT,
    userId: 'user-1' as UserId,
    traceId: 'trace-1',
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    attempt: 0,
    payload: { hello: 'world' },
    ...overrides,
  } as BaseJob<unknown>;
}

describe('jobContextOf', () => {
  it('extracts the three context fields from the envelope', () => {
    const { context } = jobContextOf(jobWith(validEnvelope()));

    expect(context.tenantId).toBe(TENANT);
    expect(context.userId).toBe('user-1');
    expect(context.traceId).toBe('trace-1');
    expect(context.jobId).toBe('job-1');
  });

  it('carries a null userId through for system jobs', () => {
    const { context } = jobContextOf(jobWith(validEnvelope({ userId: null })));
    expect(context.userId).toBeNull();
  });

  it('returns the payload alongside the context, so a processor need not re-read unvalidated data', () => {
    const { envelope } = jobContextOf(jobWith(validEnvelope()));
    expect(envelope.payload).toEqual({ hello: 'world' });
  });

  it('refuses a payload with no tenant id, rather than defaulting to something', () => {
    expect(() => jobContextOf(jobWith(validEnvelope({ tenantId: undefined })))).toThrow(
      JobContextError,
    );
  });

  it('refuses a payload with no traceId, so a job cannot lose its correlation', () => {
    expect(() => jobContextOf(jobWith(validEnvelope({ traceId: '' })))).toThrow(JobContextError);
  });

  it('names every missing field, not only the first', () => {
    try {
      jobContextOf(jobWith({ id: 'x' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(JobContextError);
      expect((error as JobContextError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('withJobContext', () => {
  it('establishes the tenant scope for the whole callback tree', async () => {
    await withJobContext(jobWith(validEnvelope()), async () => {
      // This is what Prisma's tenant extension reads. A worker processor three
      // calls deep therefore issues a scoped query without threading a tenant id.
      expect(currentTenantScope()?.tenantId).toBe(TENANT);
    });
  });

  it('survives an await inside the callback', async () => {
    await withJobContext(jobWith(validEnvelope()), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentTenantScope()?.tenantId).toBe(TENANT);
    });
  });

  it('does not leak the scope after the callback settles', async () => {
    await withJobContext(jobWith(validEnvelope()), async () => undefined);
    // A leaked scope would let the *next* job on this worker's event loop inherit
    // the previous tenant — the exact cross-tenant bug this module exists to stop.
    expect(currentTenantScope()).toBeUndefined();
  });

  it('does not leak the scope when the callback throws', async () => {
    await expect(
      withJobContext(jobWith(validEnvelope()), async () => {
        throw new Error('processor blew up');
      }),
    ).rejects.toThrow('processor blew up');

    expect(currentTenantScope()).toBeUndefined();
  });

  it('maps traceId onto the ambient requestId, so logs join up across the gap', async () => {
    await withJobContext(jobWith(validEnvelope()), async () => {
      // A job's log lines and the enqueueing request's log lines share one id,
      // which is the whole reason traceId is on the envelope.
      expect(currentTenantScope()?.requestId).toBe('trace-1');
    });
  });

  it('omits userId from the scope for a system job rather than inventing one', async () => {
    await withJobContext(jobWith(validEnvelope({ userId: null })), async () => {
      expect(currentTenantScope()?.userId).toBeUndefined();
    });
  });

  it('passes the context to the callback so a processor can log the trace', async () => {
    const seen = await withJobContext(jobWith(validEnvelope()), async (context) => context.traceId);
    expect(seen).toBe('trace-1');
  });

  it('refuses to run at all when the payload has no tenant', async () => {
    const run = vi.fn();
    await expect(withJobContext(jobWith(validEnvelope({ tenantId: null })), run)).rejects.toThrow(
      JobContextError,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps two concurrent jobs in separate scopes', async () => {
    // The failure mode this guards: one job's `await` yielding to another's
    // handler, which would swap the ambient tenant mid-query.
    const observed: (string | undefined)[] = [];

    await Promise.all([
      withJobContext(jobWith(validEnvelope({ id: 'a', tenantId: TENANT })), async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        observed.push(currentTenantScope()?.tenantId);
      }),
      withJobContext(jobWith(validEnvelope({ id: 'b', tenantId: OTHER_TENANT })), async () => {
        observed.push(currentTenantScope()?.tenantId);
      }),
    ]);

    expect(observed).toEqual([OTHER_TENANT, TENANT]);
  });
});

describe('isRetryable', () => {
  it('retries an ordinary error, since the common cause is a transient blip', () => {
    expect(isRetryable(new Error('provider 503'))).toBe(true);
  });

  it('does not retry a malformed payload, which will never become valid', () => {
    // Burning four attempts on a poison payload delays the DLQ signal by seven
    // seconds and produces four identical log lines to diagnose.
    expect(isRetryable(new JobContextError(['tenantId missing']))).toBe(false);
  });

  it('honours an explicit retryable: false', () => {
    const error = Object.assign(new Error('model not allowed for this plan'), {
      retryable: false,
    });
    expect(isRetryable(error)).toBe(false);
  });

  it('honours an explicit retryable: true even on a JobContextError', () => {
    // The explicit flag wins: a processor that has decided a failure is worth
    // another attempt should not have to fight the default.
    const error = Object.assign(new JobContextError(['x']), { retryable: true });
    expect(isRetryable(error)).toBe(true);
  });

  it('ignores a non-boolean retryable flag', () => {
    expect(isRetryable({ retryable: 'yes' })).toBe(true);
  });

  it('retries a non-Error throw, which is still plausibly transient', () => {
    expect(isRetryable('boom')).toBe(true);
  });
});
