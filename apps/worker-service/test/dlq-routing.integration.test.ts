/**
 * Retry and dead-letter routing, against real Redis.
 *
 * Two claims are asserted here that a unit test cannot establish:
 *
 *  1. A job that fails really does get four attempts, and lands on its tenant's
 *     DLQ afterwards — not on a neighbour's, and not nowhere.
 *  2. A DLQ entry carries enough to replay the original job, which is the whole
 *     reason the DLQ retains the original envelope.
 *
 * Backoff is shortened to 1ms via per-job options. Waiting out the real 1s/2s/4s
 * schedule would add seven seconds per test for no extra signal: BullMQ's backoff
 * arithmetic is not what's under test, the routing that follows it is. The unit
 * tests in `src/queues/dead-letter.test.ts` cover the decision logic against the
 * real default budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  DEAD_LETTER_JOB_OPTIONS,
  DEFAULT_JOB_OPTIONS,
  DLQ_REASON,
  QUEUE_NAMES,
} from '@orbitoz/shared-types';
import { DeadLetterRouter, replayDeadLetter } from '../src/queues/dead-letter.js';
import { isRetryable } from '../src/context/job-context.js';
import { WorkerTestHarness, envelope, waitFor, type TestJobEnvelope } from './harness.js';
import type { Job } from 'bullmq';

const TIMEOUT_MS = 30_000;

/** Backoff collapsed to milliseconds; see the file header for why. */
const FAST_RETRY = { type: 'exponential', delay: 1 } as const;

let harness: WorkerTestHarness;

beforeAll(async () => {
  harness = new WorkerTestHarness();
  await harness.assertReachable();
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

/**
 * A worker that always fails, wired exactly as `TenantWorker` wires one.
 *
 * The DLQ route happens in the `failed` event rather than a `catch`, because that
 * is where BullMQ has incremented `attemptsMade`. A catch-based version of this
 * helper is what the suite was originally written against, and it produced a
 * passing-looking integration suite in which nothing was ever dead-lettered: on
 * the last attempt a catch sees 3 of 4, decides the budget is not spent, and the
 * job dies silently into the failed set. Only running the real wiring catches
 * that class of bug.
 */
function failingWorker(
  tenantId: string,
  router: DeadLetterRouter,
  onAttempt: (attemptsMade: number) => void,
  failWith: (job: Job<TestJobEnvelope<{ readonly reason: string }>>) => Error = (job) =>
    new Error(`provider unavailable (attempt ${job.attemptsMade + 1})`),
) {
  const worker = harness.startWorker<{ readonly reason: string }>(
    tenantId,
    QUEUE_NAMES.AiInference,
    async (job) => {
      onAttempt(job.attemptsMade);
      const error = failWith(job);
      if (isRetryable(error)) throw error;

      // Mirrors `TenantWorker.handle`'s poison path. `withJobContext` is not called
      // here: the harness already wraps the processor, exactly as production does.
      const unrecoverable = new UnrecoverableError(error.message) as Error & {
        retryable?: boolean;
      };
      unrecoverable.retryable = false;
      throw unrecoverable;
    },
  );

  // The error object from the event, not `new Error(job.failedReason)`: the DLQ
  // decision reads `retryable` off it, and rebuilding it from the message string
  // drops that flag — turning every poison job into a retryable one, which then
  // never reaches the DLQ because its budget is unspent.
  worker.on('failed', (job, error) => {
    if (job === undefined) return;
    void router.route(job, error ?? new Error('failed'));
  });

  return worker;
}

describe('dead letter routing', () => {
  it(
    'gives a failing job four attempts, then files it on that tenant DLQ',
    async () => {
      const tenant = harness.tenant('retry');
      const router = new DeadLetterRouter(harness.queueRegistry);
      const attempts: number[] = [];

      const worker = failingWorker(tenant.id, router, (made) => attempts.push(made));

      const queue = harness.queue<{ readonly reason: string }>(tenant.id, QUEUE_NAMES.AiInference);
      await queue.add('workflow.run', envelope(tenant.id, { reason: 'upstream 503' }), {
        backoff: FAST_RETRY,
      });

      const dlq = harness.queue(tenant.id, QUEUE_NAMES.DeadLetter);
      await waitFor(() => dlq.getWaitingCount().then((count) => count === 1), {
        timeoutMs: TIMEOUT_MS,
        describe: () => `attempts so far: ${attempts.length}`,
      });

      // Four attempts: one initial try plus three retries, which is the configured
      // budget. Fewer would mean the retry policy is not being applied to jobs the
      // worker itself created; more would mean it is being bypassed.
      expect(attempts).toHaveLength(DEFAULT_JOB_OPTIONS.attempts);
      expect(attempts).toEqual([0, 1, 2, 3]);

      // The job is also in BullMQ's failed set, which is what an operator sees
      // first. Both records exist on purpose: the failed set is trimmed by
      // `removeOnFail`, the DLQ is not.
      await waitFor(() => queue.getFailedCount().then((count) => count === 1), {
        timeoutMs: TIMEOUT_MS,
      });
      expect(await queue.getFailedCount()).toBe(1);

      const [entry] = await dlq.getJobs(['waiting']);
      expect(entry).toBeDefined();
      expect(entry!.data).toMatchObject({
        sourceQueue: QUEUE_NAMES.AiInference,
        sourceJobName: 'workflow.run',
        reason: DLQ_REASON.Exhausted,
      });
      expect((entry!.data as { original: { tenantId: string } }).original.tenantId).toBe(tenant.id);

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'files the DLQ entry on the failing job own tenant, not any other',
    async () => {
      const tenantA = harness.tenant('A');
      const tenantB = harness.tenant('B');
      const router = new DeadLetterRouter(harness.queueRegistry);
      const worker = failingWorker(tenantA.id, router, () => undefined);

      const queueA = harness.queue(tenantA.id, QUEUE_NAMES.AiInference);
      await queueA.add('workflow.run', envelope(tenantA.id, { reason: 'boom' }), {
        backoff: FAST_RETRY,
      });

      const dlqA = harness.queue(tenantA.id, QUEUE_NAMES.DeadLetter);
      const dlqB = harness.queue(tenantB.id, QUEUE_NAMES.DeadLetter);

      await waitFor(() => dlqA.getWaitingCount().then((count) => count === 1), {
        timeoutMs: TIMEOUT_MS,
      });

      // B's DLQ is untouched. This is the assertion that matters during an
      // incident: an operator working through one tenant's backlog must never see
      // another tenant's failures, or worse, replay them.
      expect(await dlqB.getWaitingCount()).toBe(0);
      expect(await dlqB.getFailedCount()).toBe(0);

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'gives a DLQ job a single attempt, so a poison entry cannot loop',
    async () => {
      const tenant = harness.tenant('dlq-options');
      const dlq = harness.queue(tenant.id, QUEUE_NAMES.DeadLetter);

      // Read back from Redis rather than trusting the in-memory options: what
      // matters is what a *different process* would consume.
      expect(dlq.opts.defaultJobOptions?.attempts).toBe(DEAD_LETTER_JOB_OPTIONS.attempts);
      expect(dlq.opts.defaultJobOptions?.removeOnFail).toBe(DEAD_LETTER_JOB_OPTIONS.removeOnFail);

      let attempts = 0;
      const dlqWorker = harness.startWorker<{ readonly reason: string }>(
        tenant.id,
        QUEUE_NAMES.DeadLetter,
        async () => {
          attempts += 1;
          throw new Error('still broken');
        },
      );

      await dlq.add('dead-letter', { reason: 'still broken' });
      await waitFor(() => attempts >= 1, { timeoutMs: TIMEOUT_MS });

      // Give a second attempt a chance to appear, then confirm it did not.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(attempts).toBe(1);

      await dlqWorker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'routes a non-retryable failure straight to the DLQ, without burning the budget',
    async () => {
      const tenant = harness.tenant('poison');
      const router = new DeadLetterRouter(harness.queueRegistry);
      const attempts: number[] = [];

      // `retryable: false` is how a processor says "this will never work" — a plan
      // that does not include the requested model, say.
      const worker = failingWorker(
        tenant.id,
        router,
        (made) => attempts.push(made),
        () => Object.assign(new Error('model not available on this plan'), { retryable: false }),
      );

      const queue = harness.queue(tenant.id, QUEUE_NAMES.AiInference);
      await queue.add('workflow.run', envelope(tenant.id, { reason: 'plan upgrade required' }), {
        backoff: FAST_RETRY,
      });

      const dlq = harness.queue(tenant.id, QUEUE_NAMES.DeadLetter);
      await waitFor(() => dlq.getWaitingCount().then((count) => count === 1), {
        timeoutMs: TIMEOUT_MS,
        describe: () => `attempts so far: ${attempts.length}`,
      });

      // One attempt, not four. Retrying a poison payload delays the operator's
      // signal and produces four identical log lines to diagnose.
      expect(attempts).toEqual([0]);

      const [entry] = await dlq.getJobs(['waiting']);
      expect(entry!.data).toMatchObject({ reason: DLQ_REASON.NonRetryable });

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'replays a DLQ entry back onto its source queue under its own tenant',
    async () => {
      const tenant = harness.tenant('replay');
      const queue = harness.queue(tenant.id, QUEUE_NAMES.AiInference);
      const dlq = harness.queue(tenant.id, QUEUE_NAMES.DeadLetter);

      const original = envelope(tenant.id, { workflowId: 'wf-replay' });
      await dlq.add('dead-letter', {
        sourceQueue: QUEUE_NAMES.AiInference,
        sourceJobName: 'workflow.run',
        sourceJobId: 'original-1',
        reason: DLQ_REASON.Exhausted,
        failure: { name: 'Error', message: 'upstream 503', attempts: 4, failedAt: 'now' },
        original,
      });

      const [entry] = await dlq.getJobs(['waiting']);
      const newId = await replayDeadLetter(harness.queueRegistry, entry!.data as never, tenant.id);

      expect(newId).not.toBe('unknown');

      // The replay landed on the source queue, in the same tenant's namespace.
      await waitFor(() => queue.getWaitingCount().then((count) => count === 1), {
        timeoutMs: TIMEOUT_MS,
      });
      const replayed = await queue.getJob(newId);
      expect(replayed!.data).toMatchObject({ tenantId: tenant.id, traceId: original.traceId });

      // Still in the DLQ: replay is a copy, not a move, so an operator's decision
      // remains auditable.
      expect(await dlq.getWaitingCount()).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to replay an entry whose envelope names a different tenant than the DLQ it was found in',
    async () => {
      const tenant = harness.tenant('replay-guard');
      const dlq = harness.queue(tenant.id, QUEUE_NAMES.DeadLetter);

      // An entry edited in Redis to carry another tenant's id. Replaying it would
      // enqueue that tenant's job in that tenant's namespace — a cross-tenant
      // write primitive for anyone who can write to a DLQ. The guard compares the
      // envelope against the namespace the entry was read from.
      const other = '33333333-3333-4333-8333-333333333333';
      await dlq.add('dead-letter', {
        sourceQueue: QUEUE_NAMES.AiInference,
        sourceJobName: 'workflow.run',
        reason: DLQ_REASON.Exhausted,
        original: envelope(other, { workflowId: 'wf-x' }),
      });

      const [entry] = await dlq.getJobs(['waiting']);
      await expect(
        replayDeadLetter(harness.queueRegistry, entry!.data as never, tenant.id),
      ).rejects.toThrow(/another tenant namespace/);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses to replay an entry with no tenant id at all',
    async () => {
      const tenant = harness.tenant('replay-untagged');

      await expect(
        replayDeadLetter(
          harness.queueRegistry,
          {
            sourceQueue: QUEUE_NAMES.AiInference,
            sourceJobName: 'workflow.run',
            reason: DLQ_REASON.Exhausted,
            original: { tenantId: undefined },
          } as never,
          tenant.id,
        ),
      ).rejects.toThrow(/no tenant id/);
    },
    TIMEOUT_MS,
  );
});
