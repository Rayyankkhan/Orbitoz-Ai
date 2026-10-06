/**
 * Tenant context propagation, through a real worker.
 *
 * The unit tests in `src/context/job-context.test.ts` prove `withJobContext`
 * establishes and clears ambient scope. What they cannot show is that a *BullMQ
 * worker* running a real job establishes it at all — the plumbing between
 * `worker.on`, the processor, and `AsyncLocalStorage` is where a missing call
 * would live, and a missing call is invisible until a query runs unscoped.
 *
 * The assertion is therefore about the tenant a processor observes, not about a
 * return value: `currentTenantScope()` is what the Prisma extension reads, so if
 * it names the right tenant here, every query inside the processor is scoped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '@orbitoz/shared-types';
import { currentTenantScope } from '@orbitoz/database';
import { withJobContext } from '../src/context/job-context.js';
import { WorkerTestHarness, delay, envelope, waitFor, type TestJobEnvelope } from './harness.js';
import type { Job } from 'bullmq';

const TIMEOUT_MS = 20_000;

let harness: WorkerTestHarness;

beforeAll(async () => {
  harness = new WorkerTestHarness();
  await harness.assertReachable();
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

interface ObservedScope {
  readonly tenantId: string | undefined;
  readonly userId: string | undefined;
  readonly requestId: string | undefined;
}

describe('tenant context propagation', () => {
  it(
    'gives a processor the tenant, user, and trace id from its envelope',
    async () => {
      const tenant = harness.tenant('context');
      const job = envelope(tenant.id, { workflowId: 'wf-context' });

      const seen: ObservedScope[] = [];
      const worker = harness.startWorker(tenant.id, QUEUE_NAMES.AiInference, async () => {
        const scope = currentTenantScope();
        seen.push({
          tenantId: scope?.tenantId,
          userId: scope?.userId,
          // The envelope calls it `traceId`; ambient scope calls it `requestId`.
          // Same value, and the mapping is what lets a job's log line be joined to
          // the request that enqueued it.
          requestId: scope?.requestId,
        });
      });

      await harness
        .queue(tenant.id, QUEUE_NAMES.AiInference)
        .add('workflow.run', job, { jobId: 'context-1' });

      await waitFor(() => seen.length === 1, { timeoutMs: TIMEOUT_MS });

      expect(seen).toEqual([{ tenantId: tenant.id, userId: job.userId, requestId: job.traceId }]);

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'scopes the tenant correctly across several concurrent jobs',
    async () => {
      const tenant = harness.tenant('concurrent');
      const seen: (string | undefined)[] = [];

      const worker = harness.startWorker<{ readonly delayMs: number }>(
        tenant.id,
        QUEUE_NAMES.AiInference,
        async (job) => {
          // The jobs interleave deliberately: the slow one starts first, so the
          // fast one finishes while the slow one is suspended mid-`await`. If the
          // scope were stored in a shared variable rather than
          // AsyncLocalStorage, the slow job would observe the fast one's tenant.
          await delay(job.data.payload.delayMs);
          seen.push(currentTenantScope()?.tenantId);
        },
      );

      const queue = harness.queue<{ readonly delayMs: number }>(tenant.id, QUEUE_NAMES.AiInference);
      await Promise.all(
        [120, 10, 60, 0, 30].map((delayMs, index) =>
          queue.add('workflow.run', envelope(tenant.id, { delayMs }), {
            jobId: `concurrent-${index}`,
            attempts: 1,
          }),
        ),
      );

      await waitFor(() => seen.length === 5, { timeoutMs: TIMEOUT_MS });

      // Every job, whichever tenant it belongs to, saw its own tenant. Same
      // namespace here, so the assertion is about the mechanism rather than the
      // keyspace: scope follows the job, not the worker.
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set([tenant.id]));

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'leaves no ambient scope behind once a job finishes',
    async () => {
      const tenant = harness.tenant('cleanup');

      const worker = harness.startWorker(tenant.id, QUEUE_NAMES.AiInference, async () => undefined);
      const queue = harness.queue(tenant.id, QUEUE_NAMES.AiInference);
      await queue.add('workflow.run', envelope(tenant.id, { n: 1 }), { jobId: 'cleanup-1' });

      await waitFor(() => queue.getCompletedCount().then((count) => count === 1), {
        timeoutMs: TIMEOUT_MS,
      });

      // Checked outside `withJobContext`, from the worker's own event loop. A
      // leaked scope would let the next job on this process inherit the previous
      // tenant — the exact cross-tenant bug the keyspace prefix rules out and a
      // stray AsyncLocalStorage scope would reintroduce.
      await delay(100);
      expect(currentTenantScope()).toBeUndefined();

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses a job whose payload claims no tenant, without running the processor',
    async () => {
      const tenant = harness.tenant('unattributable');
      let ran = false;

      const worker = harness.startWorker(tenant.id, QUEUE_NAMES.AiInference, async () => {
        ran = true;
      });

      const queue = harness.queue(tenant.id, QUEUE_NAMES.AiInference);
      // An envelope with no tenant, written directly rather than through
      // `envelope()` — exactly what a producer bug or a hand-edited key would
      // produce.
      await queue.add(
        'workflow.run',
        {
          id: 'broken',
          traceId: 'trace-broken',
          userId: null,
          enqueuedAt: new Date().toISOString(),
          attempt: 0,
          payload: {},
        },
        { jobId: 'unattributable-1', attempts: 1 },
      );

      await waitFor(() => queue.getFailedCount().then((count) => count === 1), {
        timeoutMs: TIMEOUT_MS,
      });
      await delay(200);

      // The processor never ran: with no tenant there is no scope to run it in, and
      // running it anyway is how a job ends up touching the wrong tenant's data.
      expect(ran).toBe(false);

      const [failed] = await queue.getJobs(['failed']);
      expect(failed!.failedReason).toMatch(/tenantId/);

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'surfaces the tenant context to a processor that inspects the job directly',
    async () => {
      const tenant = harness.tenant('both-views');
      const observed: { fromEnvelope: string; fromScope: string | undefined }[] = [];

      const worker = harness.startWorker<{ readonly workflowId: string }>(
        tenant.id,
        QUEUE_NAMES.AiInference,
        async (job: Job<TestJobEnvelope<{ readonly workflowId: string }>>) => {
          observed.push({
            fromEnvelope: job.data.tenantId,
            fromScope: currentTenantScope()?.tenantId,
          });
        },
      );

      await harness
        .queue(tenant.id, QUEUE_NAMES.AiInference)
        .add('workflow.run', envelope(tenant.id, { workflowId: 'wf-both' }));

      await waitFor(() => observed.length === 1, { timeoutMs: TIMEOUT_MS });

      // Both views agree. A processor reading `job.data.tenantId` and a query
      // reading ambient scope must never disagree about who the job belongs to.
      expect(observed).toEqual([{ fromEnvelope: tenant.id, fromScope: tenant.id }]);

      await worker.close(true);
    },
    TIMEOUT_MS,
  );

  it(
    'withJobContext is the mechanism; calling it directly proves the same scope',
    async () => {
      const tenant = harness.tenant('direct');
      const job = envelope(tenant.id, { n: 1 }) as TestJobEnvelope<unknown>;

      await withJobContext({ data: job } as unknown as Job<never>, async () => {
        expect(currentTenantScope()?.tenantId).toBe(tenant.id);
      });
    },
    TIMEOUT_MS,
  );
});
