/**
 * The inference job processor.
 *
 * The handler is invoked *inside* the job's tenant scope by {@link TenantWorker},
 * so this class does not re-derive a tenant id: one place establishes the scope,
 * and every processor trusts it. What it does own is the translation from the
 * BullMQ job onto {@link InferenceRunner} — including the two pieces of retry
 * bookkeeping (`attemptsMade`, `opts.attempts`) that only the queue job knows.
 *
 * The routing, failover, provider calls, structured parsing and persistence all
 * live behind the runner, which is why this file has no `ProviderClient` or Prisma
 * import: a processor that reached for either would be re-implementing the runner
 * badly, and would put tenant scoping in two places.
 *
 * Errors are propagated on purpose. BullMQ's retry and DLQ routing are driven by
 * the thrown error, so swallowing it here would mark the job complete and leave
 * the tenant waiting forever for a result that never came.
 */
import { Logger } from '@nestjs/common';
import { INFERENCE_JOB, type InferenceJobPayload } from '@orbitoz/shared-types';
import type { InferenceRunner } from '../ai/inference-runner.js';
import { isRetryable } from '../context/job-context.js';
import type { TenantJobProcessor } from './tenant-worker.js';

export class InferenceProcessor {
  private readonly logger = new Logger(InferenceProcessor.name);

  constructor(private readonly runner: InferenceRunner) {}

  readonly process: TenantJobProcessor<InferenceJobPayload> = async (context, job) => {
    const { tenantId, id, payload } = job.data;
    this.logger.log(
      `Processing ${id} for tenant ${tenantId.slice(0, 8)} (${payload.model}), trace ${context.traceId}`,
    );

    if (job.name === INFERENCE_JOB.Cancel) {
      this.logger.log(`Cancellation requested for ${id}`);
    }

    await this.runner.run({
      tenantId,
      jobId: id,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      payload,
    });
  };
}

/**
 * The worker's retry policy, in the shape the runner needs.
 *
 * `isRetryable` is the same predicate `TenantWorker.handle` uses to decide between
 * a plain rethrow and an `UnrecoverableError`. Sharing it is what keeps the
 * persisted status and the queue's behaviour in agreement: a non-retryable failure
 * is terminal in both, so the database never shows `QUEUED` for a job BullMQ has
 * already dead-lettered.
 */
export function inferenceShouldRetry(
  error: unknown,
  attemptsMade: number,
  maxAttempts: number,
): boolean {
  return isRetryable(error) && attemptsMade + 1 < maxAttempts;
}
