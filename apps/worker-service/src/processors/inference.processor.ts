/**
 * The inference job processor — provider routing is not implemented yet.
 *
 * What is real here is the part that is easy to get wrong: the tenant comes
 * from the job envelope, never from ambient state, and every database call goes
 * through `withTenant` so the job runs in a transaction with Row Level Security
 * pinned to that tenant.
 *
 * A worker has no request to inherit a scope from, so it must establish one per
 * job. That is the single largest source of cross-tenant bugs in worker code: a
 * job for tenant A silently reading or writing tenant B's rows.
 */
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { INFERENCE_JOB, type BaseJob, type InferenceJobPayload } from '@orbitoz/shared-types';
import type { PrismaClient } from '@orbitoz/database';

export class InferenceProcessor {
  private readonly logger = new Logger(InferenceProcessor.name);

  constructor(private readonly prisma: PrismaClient) {}

  async process(job: Job<BaseJob<InferenceJobPayload>>): Promise<void> {
    const { tenantId, id, payload } = job.data;
    this.logger.log(`Processing ${id} for tenant ${tenantId.slice(0, 8)} (${payload.model})`);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', tenantId);

      const record = await tx.inferenceJob.findUnique({
        where: { tenantId_id: { tenantId, id } },
      });
      if (!record) {
        // The row is written by the gateway before enqueueing. Its absence means
        // the job outlived its record, so there is nothing safe to do but stop.
        this.logger.warn(`Job ${id} has no inference_jobs row for this tenant; skipping.`);
        return;
      }

      await tx.inferenceJob.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
      });

      if (job.name === INFERENCE_JOB.Cancel) {
        this.logger.log(`Cancellation requested for ${id}`);
        return;
      }

      // Provider call, attempt recording and cost accounting land here. Left
      // explicit rather than stubbed so the transaction boundary is visible
      // while it is still cheap to change.
      this.logger.debug('Provider routing is not implemented yet; no provider was called.');
    });
  }
}
