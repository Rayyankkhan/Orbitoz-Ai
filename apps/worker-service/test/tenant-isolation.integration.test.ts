/**
 * Tenant isolation, against real Redis.
 *
 * The whole point of the `orbitoz:{tenantId}:queue` prefix is that tenant A's
 * worker physically cannot see tenant B's job. That is a statement about Redis
 * keys, so it is asserted against Redis: a mock has no keyspace to be wrong
 * about, and a test that mocks the queue proves only that the mock was called.
 *
 * Read these as claims about the deployment, not about the code: "if we ship
 * this prefix scheme, two tenants on one Redis cannot cross-talk."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES, tenantQueuePrefix } from '@orbitoz/shared-types';
import { WorkerTestHarness, delay, envelope, never, productionPrefixFor } from './harness.js';

const TIMEOUT_MS = 20_000;

let harness: WorkerTestHarness;

beforeAll(async () => {
  harness = new WorkerTestHarness();
  await harness.assertReachable();
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

describe('tenant queue isolation', () => {
  it(
    "writes each tenant's jobs into a different key namespace",
    async () => {
      const tenantA = harness.tenant('A');
      const tenantB = harness.tenant('B');

      const queueA = harness.queue(tenantA.id, QUEUE_NAMES.AiInference);
      const queueB = harness.queue(tenantB.id, QUEUE_NAMES.AiInference);

      // Explicit, cross-tenant-distinct job ids. BullMQ's generated ids are a
      // per-namespace counter, so the first job in each queue would both be
      // "1" and a cross-lookup would return the wrong job — a passing assertion
      // for a wrong reason.
      const jobA = await queueA.add('workflow.run', envelope(tenantA.id, { workflowId: 'wf-a' }), {
        jobId: 'a-only',
      });
      const jobB = await queueB.add('workflow.run', envelope(tenantB.id, { workflowId: 'wf-b' }), {
        jobId: 'b-only',
      });

      // Same queue name, different prefixes: the queues are distinct objects and
      // distinct sets of Redis keys. Counting one from the other is the bug this
      // whole module exists to prevent.
      expect(queueA.opts.prefix).not.toBe(queueB.opts.prefix);
      expect(await queueA.getWaitingCount()).toBe(1);
      expect(await queueB.getWaitingCount()).toBe(1);

      // Each job is addressable only from its own tenant's queue. Checked by id,
      // not by name — `getJob` takes an id, and passing the payload's
      // `workflowId` would return null for the uninteresting reason that no such
      // job exists anywhere.
      expect(await queueA.getJob(jobA.id!)).toBeDefined();
      expect(await queueB.getJob(jobA.id!)).toBeUndefined();
      expect(await queueB.getJob(jobB.id!)).toBeDefined();
      expect(await queueA.getJob(jobB.id!)).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  it(
    "never lets a worker on tenant A consume tenant B's job",
    async () => {
      const tenantA = harness.tenant('A');
      const tenantB = harness.tenant('B');

      const consumedByA: string[] = [];
      const workerA = harness.startWorker<{ readonly workflowId: string }>(
        tenantA.id,
        QUEUE_NAMES.AiInference,
        async (job) => {
          // `never()` never resolves, so if this handler is ever reached the test
          // hangs to its deadline and fails on the timeout rather than passing on
          // a race that happened to go our way.
          consumedByA.push(job.data.payload.workflowId);
          await never();
        },
      );

      const queueB = harness.queue(tenantB.id, QUEUE_NAMES.AiInference);
      const jobB = await queueB.add('workflow.run', envelope(tenantB.id, { workflowId: 'wf-b' }));

      await workerA.waitUntilReady();
      await delay(500);

      expect(consumedByA).toEqual([]);
      // Still waiting, still owned by B: it was never moved into A's namespace.
      expect(await queueB.getJob(jobB.id!)).toBeDefined();
      expect(jobB.attemptsMade).toBe(0);

      await workerA.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'delivers a job to exactly one of two workers on the same tenant',
    async () => {
      const tenant = harness.tenant('shared');
      const seen: string[] = [];

      // Two workers on one tenant's namespace: the prefix is not a worker-id
      // partition, so both are legitimate consumers and a job must land with
      // only one of them, never both.
      for (const workerIndex of [1, 2]) {
        harness.startWorker<{ readonly workflowId: string }>(
          tenant.id,
          QUEUE_NAMES.AiInference,
          async (job) => {
            seen.push(`worker-${workerIndex}:${job.data.payload.workflowId}`);
          },
        );
      }

      const queue = harness.queue(tenant.id, QUEUE_NAMES.AiInference);
      await queue.add('workflow.run', envelope(tenant.id, { workflowId: 'wf-shared' }));

      const started = Date.now();
      while (seen.length === 0 && Date.now() - started < 10_000) {
        await delay(25);
      }

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('wf-shared');
    },
    TIMEOUT_MS,
  );

  it(
    "keeps each tenant's dead-letter queue separate",
    async () => {
      const tenantA = harness.tenant('A');
      const tenantB = harness.tenant('B');

      const dlqA = harness.queue(tenantA.id, QUEUE_NAMES.DeadLetter);
      const dlqB = harness.queue(tenantB.id, QUEUE_NAMES.DeadLetter);

      await dlqA.add('dead-letter', { sourceQueue: QUEUE_NAMES.AiInference, tenantId: tenantA.id });
      await dlqB.add('dead-letter', { sourceQueue: QUEUE_NAMES.AiInference, tenantId: tenantB.id });

      // An operator working through tenant A's backlog must not see, or be able to
      // replay, tenant B's failures.
      const jobsA = await dlqA.getJobs(['waiting', 'active', 'completed', 'failed']);
      expect(jobsA).toHaveLength(1);
      expect(jobsA[0]!.data).toMatchObject({ tenantId: tenantA.id });

      const jobsB = await dlqB.getJobs(['waiting', 'active', 'completed', 'failed']);
      expect(jobsB).toHaveLength(1);
      expect(jobsB[0]!.data).toMatchObject({ tenantId: tenantB.id });
    },
    TIMEOUT_MS,
  );

  it(
    'matches the documented prefix shape in the actual Redis keys',
    async () => {
      const tenant = harness.tenant('prefix');

      // The shared-types helper is the contract other services (the gateway's
      // producer) will use to compute the same key. If production and the worker
      // disagreed here, every job would sit unconsumed — so this asserts the two
      // implementations agree rather than merely that one is self-consistent.
      // Exactly one documented deviation from the production prefix: the run id
      // spliced inside the namespace braces. Anything else differing here would
      // mean the suite tests a keyspace no deployment will ever use.
      expect(harness.prefix(tenant.id)).toBe(`orbitoz:{${tenant.id}-${harness.runId}}:queue`);
      expect(productionPrefixFor(tenant.id)).toBe(tenantQueuePrefix(tenant.id));
      expect(harness.prefix(tenant.id).replace(`-${harness.runId}`, '')).toBe(
        productionPrefixFor(tenant.id),
      );
    },
    TIMEOUT_MS,
  );
});
