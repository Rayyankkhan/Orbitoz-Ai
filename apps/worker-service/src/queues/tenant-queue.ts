/**
 * Tenant-namespaced BullMQ queue construction.
 *
 * Every key in Redis for a job is `<prefix>:<queueName>:<type>`, and BullMQ
 * throws on a queue name containing a colon. So the tenant namespace goes in
 * the `prefix` option and the queue name stays bare — which is what produces
 * `orbitoz:{tenantId}:queue:{queueName}`.
 *
 * The practical win is that tenancy becomes a property of the *keyspace* rather
 * than a field a processor has to remember to check. A worker subscribed to
 * tenant A's queue cannot see tenant B's backlog, cannot consume from it, and
 * cannot be configured to — the isolation lives in Redis, not in application
 * code. That is the same reasoning as the RLS layer: prefer a boundary the
 * mistake cannot cross over one the mistake has to avoid.
 *
 * The cost is real and worth stating: one queue per tenant per queue-type means a
 * worker subscribed to N tenants holds N blocking connections, and BullMQ
 * discovers work by blocking on keys rather than by scanning for them. See
 * {@link TenantQueueRegistry} for how connections are kept bounded.
 */
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  DEAD_LETTER_JOB_OPTIONS,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  tenantQueuePrefix,
  type QueueName,
} from '@orbitoz/shared-types';

export interface TenantQueueOptions {
  readonly connection: Redis;
  /** Overrides {@link DEFAULT_JOB_OPTIONS}. The DLQ uses its own. */
  readonly defaultJobOptions?: JobsOptions;
  /**
   * Distinguishes deployments sharing one Redis, appended inside the namespace
   * braces: `orbitoz:{<tenantId>-staging}:queue`.
   *
   * Optional, and unused in a single-environment deployment. It exists because a
   * shared Redis is the normal case for staging against a production-shaped
   * instance, and without a segment a staging worker would consume production
   * jobs — the same class of cross-talk as two tenants sharing a keyspace, one
   * level up. Integration tests pass a run id here for the same reason.
   */
  readonly namespaceSuffix?: string;
}

/**
 * The tenant-namespaced Redis prefix for a queue.
 *
 * Thin wrapper over the shared helper so callers import one thing from here and
 * the prefix format stays defined in exactly one file.
 */
export function queuePrefixFor(tenantId: string, namespaceSuffix?: string): string {
  const base = tenantQueuePrefix(tenantId);
  if (!namespaceSuffix) return base;

  assertTenantIdShape(namespaceSuffix);
  // `tenantQueuePrefix` yields `orbitoz:{<id>}:queue`; splice the suffix in before
  // the closing brace so the namespace stays one delimited segment and the
  // cleanup pattern can still match on it exactly.
  return base.replace(`{${tenantId}}`, `{${tenantId}-${namespaceSuffix}}`);
}

/** Creates one tenant's copy of one queue. */
export function createTenantQueue<T = unknown>(
  tenantId: string,
  queueName: QueueName,
  options: TenantQueueOptions,
): Queue<T> {
  assertTenantIdShape(tenantId);

  return new Queue<T>(queueName, {
    connection: options.connection,
    prefix: queuePrefixFor(tenantId, options.namespaceSuffix),
    defaultJobOptions: options.defaultJobOptions ?? DEFAULT_JOB_OPTIONS,
  });
}

/** A tenant's Dead Letter Queue, with the no-retry job options. */
export function createDeadLetterQueue<T = unknown>(
  tenantId: string,
  options: TenantQueueOptions,
): Queue<T> {
  return createTenantQueue<T>(tenantId, QUEUE_NAMES.DeadLetter, {
    connection: options.connection,
    defaultJobOptions: DEAD_LETTER_JOB_OPTIONS,
    ...(options.namespaceSuffix ? { namespaceSuffix: options.namespaceSuffix } : {}),
  });
}

/**
 * Rejects a tenant id that could forge a different Redis namespace.
 *
 * A tenant id reaches this code from a job envelope in Redis, which is untrusted
 * input. `{` and `}` delimit the namespace in the key format and `:` separates
 * prefix from queue name, so a value containing any of them could produce a key
 * that collides with — or reads from — another tenant's keys. Real ids are UUIDs
 * and contain none of these.
 *
 * This is defence in depth, not the primary boundary. A forged tenant id still
 * has to survive `validateJobContext` and reach a processor, and every query in a
 * processor goes through an RLS-pinned transaction keyed on the same id. But the
 * cheapest place to reject a malformed value is before it becomes a key.
 */
export function assertTenantIdShape(tenantId: string): void {
  const problems: string[] = [];

  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    problems.push('tenant id must be a non-empty string');
  }
  if (/[:{}]/.test(tenantId)) {
    problems.push('tenant id must not contain ":", "{" or "}"');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(tenantId)) {
    problems.push('tenant id must not contain whitespace or control characters');
  }

  if (problems.length > 0) {
    throw new InvalidTenantNamespaceError(tenantId, problems);
  }
}

export class InvalidTenantNamespaceError extends Error {
  constructor(
    readonly tenantId: string,
    readonly problems: readonly string[],
  ) {
    super(
      `Refusing to build a Redis namespace for ${JSON.stringify(tenantId)}: ${problems.join('; ')}. ` +
        'A malformed tenant id could collide with another tenant keys.',
    );
    this.name = 'InvalidTenantNamespaceError';
  }
}

/**
 * Owns the queue instances for the tenants a worker serves.
 *
 * BullMQ's `Queue` holds a Redis connection each, so creating them ad hoc per
 * job would exhaust the connection pool within minutes of traffic. The registry
 * creates them on demand and caches them, so a tenant has exactly one producer
 * connection per queue-type regardless of how many jobs it enqueues.
 *
 * Also the right place to hang `closeAll()` on shutdown: a queue left open
 * during a deploy holds its connection until the process is killed, which turns
 * a rolling deploy into a connection spike.
 */
export class TenantQueueRegistry {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly options: TenantQueueOptions) {}

  /**
   * The queue for `tenantId`/`queueName`, created on first use.
   *
   * Routes `dlq` to {@link deadLetterQueue} so the no-retry options cannot be
   * bypassed by asking for the DLQ through the general path: the two would
   * otherwise share a cache key, and whichever call arrived first would fix the
   * options for both.
   */
  queue<T = unknown>(tenantId: string, queueName: QueueName): Queue<T> {
    if (queueName === QUEUE_NAMES.DeadLetter) return this.deadLetterQueue<T>(tenantId);

    const key = `${tenantId} ${queueName}`;
    const existing = this.queues.get(key);
    if (existing) return existing as Queue<T>;

    const created = createTenantQueue<T>(tenantId, queueName, this.options);
    this.queues.set(key, created as Queue);
    return created;
  }

  /**
   * A tenant's Dead Letter Queue.
   *
   * Not delegated to {@link queue}: a DLQ entry that retried would be re-consumed
   * by the DLQ worker and dead-lettered again, looping forever on the same poison
   * job. `createDeadLetterQueue` supplies {@link DEAD_LETTER_JOB_OPTIONS}
   * (`attempts: 1`, `removeOnFail: false`), which `queue()`'s
   * `DEFAULT_JOB_OPTIONS` would otherwise override.
   */
  deadLetterQueue<T = unknown>(tenantId: string): Queue<T> {
    const key = `${tenantId} ${QUEUE_NAMES.DeadLetter}`;
    const existing = this.queues.get(key);
    if (existing) return existing as Queue<T>;

    const created = createDeadLetterQueue<T>(tenantId, this.options);
    this.queues.set(key, created as Queue);
    return created;
  }

  /** How many queue instances are currently open. Used by tests and metrics. */
  get size(): number {
    return this.queues.size;
  }

  /**
   * Closes every open queue.
   *
   * Idempotent — calling twice is not an error, which matters because shutdown
   * can arrive twice (an explicit close, then a signal).
   */
  async closeAll(): Promise<void> {
    const open = [...this.queues.values()];
    this.queues.clear();
    await Promise.allSettled(open.map((queue) => queue.close()));
  }
}
