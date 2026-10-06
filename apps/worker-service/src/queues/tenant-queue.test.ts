/**
 * Tenant key namespacing — the unit tests.
 *
 * These assert the prefix *format*, which is the thing that makes cross-tenant
 * isolation structural. Whether a worker can actually consume another tenant's
 * job is proven against real Redis in `test/tenant-isolation.integration.test.ts`;
 * what is checked here is that two tenants never produce the same namespace, and
 * that a hostile tenant id cannot forge one.
 */
import { describe, expect, it } from 'vitest';
import {
  QUEUE_NAMES,
  WORKER_QUEUES,
  tenantQueueKey,
  tenantQueuePrefix,
  validateJobContext,
} from '@orbitoz/shared-types';
import {
  InvalidTenantNamespaceError,
  assertTenantIdShape,
  createTenantQueue,
  queuePrefixFor,
} from './tenant-queue.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('tenantQueuePrefix', () => {
  it('matches the documented orbitoz:{tenantId}:queue shape', () => {
    expect(tenantQueuePrefix(TENANT_A)).toBe(`orbitoz:{${TENANT_A}}:queue`);
  });

  it('never places a colon inside the queue name, which BullMQ rejects', () => {
    // BullMQ throws on a queue name containing ':', so the tenant namespace has
    // to live in `prefix`. This test fails loudly if someone tries to fold the
    // tenant id into the queue name instead.
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name).not.toContain(':');
    }
  });

  it('gives two tenants distinct prefixes', () => {
    expect(tenantQueuePrefix(TENANT_A)).not.toBe(tenantQueuePrefix(TENANT_B));
  });

  it('gives one tenant distinct prefixes per queue', () => {
    const keys = WORKER_QUEUES.map((queue) => tenantQueueKey(TENANT_A, queue));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives a DLQ key that sorts under the same tenant as its source queue', () => {
    const source = tenantQueueKey(TENANT_A, QUEUE_NAMES.AiInference);
    const dlq = tenantQueueKey(TENANT_A, QUEUE_NAMES.DeadLetter);
    expect(dlq.startsWith(tenantQueuePrefix(TENANT_A))).toBe(true);
    expect(dlq).not.toBe(source);
  });

  it('keeps a brace or colon out of a forged tenant id so it cannot alias a namespace', () => {
    // Without this guard, `{other-tenant}` or `x:{other}` could construct a key
    // that reads from another tenant's namespace.
    expect(() => tenantQueuePrefix(`${TENANT_A}:${TENANT_B}`)).not.toThrow();
    // The prefix function itself is a pure string join; the guard lives in
    // assertTenantIdShape, which every queue construction goes through.
    expect(() => assertTenantIdShape(`${TENANT_A}:${TENANT_B}`)).toThrow(
      InvalidTenantNamespaceError,
    );
  });
});

describe('assertTenantIdShape', () => {
  it('accepts a real UUID', () => {
    expect(() => assertTenantIdShape(TENANT_A)).not.toThrow();
  });

  it('rejects a colon, which would forge a different namespace', () => {
    expect(() => assertTenantIdShape('a:b')).toThrow(/must not contain/);
  });

  it('rejects braces, which delimit the namespace', () => {
    expect(() => assertTenantIdShape(`{${TENANT_A}}`)).toThrow(/must not contain/);
  });

  it('rejects whitespace, which would make keys ambiguous to scan for', () => {
    expect(() => assertTenantIdShape(`${TENANT_A} `)).toThrow(/whitespace/);
  });

  it('rejects an empty id', () => {
    expect(() => assertTenantIdShape('')).toThrow(/non-empty/);
  });

  it('names the offending value and every problem, not just the first', () => {
    try {
      assertTenantIdShape('a:b {c}');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTenantNamespaceError);
      const failure = error as InvalidTenantNamespaceError;
      expect(failure.problems.length).toBeGreaterThanOrEqual(2);
      expect(failure.tenantId).toBe('a:b {c}');
      // The message must contain the value: an error saying only "invalid" sends
      // the reader hunting through logs for which tenant was rejected.
      expect(failure.message).toContain('a:b {c}');
    }
  });
});

describe('createTenantQueue', () => {
  const connection = {} as never;

  it('builds a queue carrying the tenant prefix', () => {
    const queue = createTenantQueue(TENANT_A, QUEUE_NAMES.AiInference, { connection });
    expect(queue.opts.prefix).toBe(queuePrefixFor(TENANT_A));
    expect(queue.name).toBe(QUEUE_NAMES.AiInference);
    void queue.close();
  });

  it('refuses a tenant id that could forge a namespace, before touching Redis', () => {
    expect(() =>
      createTenantQueue('evil:{other}', QUEUE_NAMES.AiInference, { connection }),
    ).toThrow(InvalidTenantNamespaceError);
  });
});

describe('validateJobContext', () => {
  const valid = {
    id: 'job-1',
    tenantId: TENANT_A,
    userId: 'user-1',
    traceId: 'trace-1',
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    attempt: 0,
    payload: { model: 'gpt-4' },
  };

  it('accepts a complete envelope', () => {
    const result = validateJobContext(valid);
    expect(result.ok).toBe(true);
  });

  it('requires tenantId, because a worker cannot process an unattributable job', () => {
    const result = validateJobContext({ ...valid, tenantId: undefined });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain('tenantId must be a non-empty string');
  });

  it('requires traceId, so a job can be correlated with its request', () => {
    const result = validateJobContext({ ...valid, traceId: '' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain('traceId must be a non-empty string');
  });

  it('requires job id', () => {
    const result = validateJobContext({ ...valid, id: undefined });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toContain('id must be a non-empty string');
  });

  it('allows a null userId, because system jobs have no human actor', () => {
    // Usage rollups and tenant provisioning are not caused by a person. Rejecting
    // them would mean either faking a user id or refusing to run them.
    expect(validateJobContext({ ...valid, userId: null }).ok).toBe(true);
  });

  it('rejects a non-string, non-null userId rather than passing it through', () => {
    const result = validateJobContext({ ...valid, userId: 42 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(validateJobContext(null).ok).toBe(false);
    expect(validateJobContext('a string').ok).toBe(false);
  });

  it('reports every missing field at once, not one per round trip', () => {
    const result = validateJobContext({});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.length).toBeGreaterThanOrEqual(3);
  });
});
