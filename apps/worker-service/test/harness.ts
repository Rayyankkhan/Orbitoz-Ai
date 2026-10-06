/**
 * The integration test harness.
 *
 * These tests are about Redis keyspaces, so they need a real Redis and real
 * BullMQ — a mocked queue would let a test pass while tenant A's worker consumed
 * tenant B's job, because the mock has no keyspace to be wrong about. That is
 * the entire claim under test, so faking it would prove nothing.
 *
 * ---------------------------------------------------------------------------
 * ISOLATION BETWEEN RUNS
 * ---------------------------------------------------------------------------
 * Every test file gets a random run id, and every key carries it. Two concurrent
 * `vitest` workers, a stale keyspace from a crashed run, and a developer's own
 * local queues all coexist without colliding — which matters because these tests
 * share one Redis with whatever else is using it.
 *
 * Tenants are random UUIDs rather than fixed strings, so a leftover keyspace from
 * an aborted run cannot be mistaken for a fresh one.
 *
 * ---------------------------------------------------------------------------
 * WHY CLEANUP IS A HARD REQUIREMENT
 * ---------------------------------------------------------------------------
 * A DLQ test leaves failed jobs in Redis by design. Across a few dozen runs that
 * is a few thousand keys that no test will ever assert against — and on a shared
 * Redis that is someone's memory. `cleanup()` removes exactly the run's own
 * namespace, never a wildcard, so a bug in the prefix calculation cannot delete
 * another tenant's queue.
 */
import { randomUUID } from 'node:crypto';
import { Worker, type Job, type JobsOptions, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE_NAMES, type BaseJob, type QueueName } from '@orbitoz/shared-types';
import { createQueueRedisConnection } from '../src/queues/connection.js';
import { TenantQueueRegistry, queuePrefixFor } from '../src/queues/tenant-queue.js';
import { withJobContext } from '../src/context/job-context.js';

/**
 * Integration Redis.
 *
 * Separate from `REDIS_URL` so a test run against a shared or staging Redis
 * cannot delete keys belonging to a real environment — the harness deletes keys,
 * and that is only acceptable against something disposable.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/** Fails fast with an actionable message rather than hanging on a dead socket. */
const CONNECT_TIMEOUT_MS = 5_000;

export interface HarnessTenant {
  readonly id: string;
  readonly label: string;
}

/**
 * A job envelope as the harness passes it around.
 *
 * The index signature is what lets a test build an envelope with a deliberately
 * malformed field — `envelope(tenant, payload, { tenantId: undefined })` — without
 * a cast at every call site. Without it, every negative test would need `as never`
 * at the argument rather than in one place.
 */
export type TestJobEnvelope<T> = BaseJob<T> & Readonly<Record<string, unknown>>;

/**
 * One isolated worker test's worth of state.
 *
 * Owns the connections, the queues, and the workers so a test can tear all of it
 * down in one call — and so a test that throws mid-assertion still cleans up.
 */
export class WorkerTestHarness {
  /** Unique per harness instance; every key this harness creates contains it. */
  readonly runId = randomUUID();

  private readonly connection: Redis;
  private readonly queues: Queue[] = [];
  private readonly workers: Worker[] = [];
  private readonly registry: TenantQueueRegistry;

  constructor(url: string = TEST_REDIS_URL) {
    this.connection = createQueueRedisConnection(url);
    // `namespaceSuffix: runId` is what keeps this run's keys separable from any
    // other run's and from a real tenant queue. Both `queue()` and
    // `startWorker()` inherit it from here, so producers and consumers cannot
    // drift apart on the prefix.
    this.registry = new TenantQueueRegistry({
      connection: this.connection,
      namespaceSuffix: this.runId,
    });
  }

  /** This run's key prefix for a tenant. See {@link testPrefix}. */
  prefixFor(tenantId: string): string {
    return testPrefix(tenantId, this.runId);
  }

  /**
   * Verifies Redis is reachable.
   *
   * @throws with a message naming the variable to set, rather than letting a
   *   blocking command time out twenty seconds later with no explanation.
   */
  async assertReachable(): Promise<void> {
    const result = await Promise.race([
      this.connection.ping().then((reply) => reply === 'PONG'),
      new Promise<false>((_, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `Redis did not respond at ${TEST_REDIS_URL} within ${CONNECT_TIMEOUT_MS}ms. ` +
                  'The worker integration tests need a live Redis. Start it with ' +
                  '`docker compose up -d redis`, or set TEST_REDIS_URL to a disposable instance.',
              ),
            ),
          CONNECT_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);

    if (!result) throw new Error(`Redis at ${TEST_REDIS_URL} did not reply PONG.`);
  }

  /** A random tenant, tagged so a failing test names which one leaked. */
  tenant(label = 'tenant'): HarnessTenant {
    return { id: randomUUID(), label };
  }

  /**
   * A queue for one tenant, on this run's namespace.
   *
   * Goes through the same registry production uses, so the prefix under test is
   * the prefix that ships.
   */
  queue<T>(tenantId: string, name: QueueName): Queue<T> {
    const queue = this.registry.queue<T>(tenantId, name);
    this.queues.push(queue as Queue);
    return queue;
  }

  /**
   * Starts a worker on one tenant's queue, wrapped the way production wraps one.
   *
   * Two details are load-bearing, and both were wrong in the first version of this
   * harness:
   *
   *  - **The prefix comes from {@link prefixFor}**, the same value `queue()`
   *    resolves to through the registry. Deriving it independently in both places
   *    produced a suite that hung rather than failed: producers wrote to one
   *    namespace, consumers polled another, and every isolation assertion silently
   *    passed because no job was ever delivered.
   *  - **The processor runs inside `withJobContext`**, mirroring
   *    `TenantWorker.handle`. Called raw, `currentTenantScope()` was `undefined`
   *    inside every processor, so a test asserting tenant propagation failed while
   *    an assertion that never read the scope passed anyway — the harness was
   *    quietly testing a worker that does not exist in production.
   *
   * The wrapper applies to job queues only. A DLQ entry is a bare
   * `DeadLetterJobPayload`, not a `BaseJob` envelope, so it has no `tenantId` at the
   * top level to build a scope from — `withJobContext` would reject it as a
   * malformed envelope before the processor ever ran. Production draws the same
   * line: `dlq` is excluded from `WORKER_QUEUES`.
   *
   * @param options.unwrap skips the `withJobContext` wrapper, for tests that want
   *   the raw processor call. Rare; the wrapper is what production does.
   */
  startWorker<T>(
    tenantId: string,
    name: QueueName,
    processor: (job: Job<TestJobEnvelope<T>>) => Promise<void>,
    options?: { concurrency?: number; unwrap?: boolean },
  ): Worker<TestJobEnvelope<T>> {
    const worker = new Worker<TestJobEnvelope<T>>(
      name,
      async (job) => {
        const scoped = options?.unwrap !== true && name !== QUEUE_NAMES.DeadLetter;
        if (!scoped) return processor(job);
        return withJobContext(job, async () => processor(job));
      },
      {
        connection: this.connection.duplicate(),
        prefix: this.prefixFor(tenantId),
        ...(options?.concurrency ? { concurrency: options.concurrency } : {}),
      },
    );
    this.workers.push(worker as Worker);
    return worker;
  }

  /** The registry, for exercising {@link TenantQueueRegistry} directly. */
  get queueRegistry(): TenantQueueRegistry {
    return this.registry;
  }

  /** Closes workers, queues, and the connection, then deletes this run's keys. */
  async cleanup(): Promise<void> {
    // Workers first: a worker polling a deleted keyspace spins on errors.
    await Promise.allSettled(this.workers.map((worker) => worker.close(true)));
    await Promise.allSettled(this.queues.map((queue) => queue.close()));
    await this.deleteRunKeys();
    await Promise.allSettled([this.registry.closeAll(), this.connection.quit()]);
  }

  /**
   * Deletes every key belonging to this run.
   *
   * Scanned with a `MATCH` on the run id and deleted in batches. `KEYS` is never
   * used: it blocks the Redis event loop for the length of the keyspace, and on a
   * shared Redis that keyspace belongs to other people.
   *
   * The pattern contains this run's UUID and nothing else, so a mistake in the
   * prefix format can at worst fail to clean up — it cannot delete a real
   * tenant's queue.
   */
  async deleteRunKeys(): Promise<number> {
    const pattern = `orbitoz:{*${this.runId}*}:queue:*`;
    let cursor = '0';
    let deleted = 0;

    do {
      const [next, keys] = await this.connection.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        // `UNLINK` rather than `DEL`: reclamation happens on a background thread,
        // so the loop scanning for more keys is not blocked behind it.
        deleted += await this.connection.unlink(...keys);
      }
    } while (cursor !== '0');

    return deleted;
  }

  /** The Redis key prefix this harness uses for a tenant. */
  prefix(tenantId: string): string {
    return this.prefixFor(tenantId);
  }
}

/**
 * Test namespace: the production prefix shape, plus the run id.
 *
 * Must match `queuePrefixFor(tenantId, namespaceSuffix)` in
 * `src/queues/tenant-queue.ts`, which is where the suffix is actually applied.
 * `prefix-shape.test.ts` asserts the two agree, so a change to one that forgets
 * the other fails a test rather than quietly stranding every job in the suite.
 */
export function testPrefix(tenantId: string, runId: string): string {
  return `orbitoz:{${tenantId}-${runId}}:queue`;
}

/**
 * Builds a valid job envelope.
 *
 * Goes through the same shape the gateway produces, including the three context
 * fields the worker requires. `overrides` exists so a test can produce a
 * deliberately *malformed* payload — the non-retryable-poison-payload path is
 * only reachable that way.
 */
export function envelope<T>(
  tenantId: string,
  payload: T,
  overrides: Partial<Record<string, unknown>> = {},
): TestJobEnvelope<T> {
  return {
    id: randomUUID(),
    tenantId,
    userId: randomUUID(),
    traceId: randomUUID(),
    enqueuedAt: new Date().toISOString(),
    attempt: 0,
    payload,
    ...overrides,
  } as TestJobEnvelope<T>;
}

/** Job options that fail fast: one attempt, no backoff. */
export const IMMEDIATE_FAIL_OPTIONS: JobsOptions = {
  attempts: 1,
  backoff: { type: 'exponential', delay: 1 },
  removeOnComplete: false,
  removeOnFail: false,
};

/**
 * Waits for `predicate` to hold, polling.
 *
 * BullMQ has no "wait until the queue is empty" primitive that is safe against
 * concurrent producers, so tests poll. The timeout is generous because a CI box
 * under parallel load can take seconds to move a job from delayed to active.
 *
 * @throws when the predicate has not held by the deadline, including the last
 *   observed value — a bare timeout tells you nothing about why.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: { timeoutMs?: number; intervalMs?: number; describe?: () => string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }

  const detail = options.describe ? ` (${options.describe()})` : '';
  throw new Error(`Condition not met within ${timeoutMs}ms${detail}`);
}

/**
 * The prefix production would use for this tenant, with no run suffix.
 *
 * Provided so a test can assert the harness namespace is the production shape
 * plus exactly one documented deviation.
 */
export function productionPrefixFor(tenantId: string): string {
  return queuePrefixFor(tenantId);
}

/** A promise that never resolves. Useful as "this must not happen" assertions. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** Resolves after `ms`. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The queues the harness should exercise. */
export const TEST_QUEUES = {
  workflow: QUEUE_NAMES.AiInference,
  webhook: QUEUE_NAMES.NotificationDispatch,
  dlq: QUEUE_NAMES.DeadLetter,
} as const;
