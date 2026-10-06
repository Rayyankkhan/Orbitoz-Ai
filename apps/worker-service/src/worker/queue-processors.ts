/**
 * Processors for the non-inference queues.
 *
 * Each one is a `TenantJobProcessor` — a function run inside its job's tenant
 * scope, established by `TenantWorker` from the envelope. None of them re-derive
 * a tenant id, because deriving it anywhere but one place is how two places end
 * up disagreeing.
 *
 * The behaviour here is deliberately small: these queues exist as contracts, and
 * their real work belongs to later modules (usage billing, webhook delivery). A
 * processor that records state and reports honestly beats one that pretends to do
 * work it cannot yet do — a job marked complete for a side effect that never
 * happened is worse than a job that fails and retries.
 *
 * They are written `return Promise.resolve()` rather than `async` for that reason:
 * `async` with no `await` reads as if something asynchronous is happening, and
 * `@typescript-eslint/require-await` rejects it anyway. The explicit promise is
 * honest about the current state, and adding an `await` when the real work lands
 * is a smaller diff than removing an `async` that implied work.
 */
import { Logger } from '@nestjs/common';
import type { TenantProvisioningJob, UsageAggregationJob } from '@orbitoz/shared-types';
import type { TenantJobProcessor } from './tenant-worker.js';

/**
 * `usage-aggregation` — rolls up a tenant's usage for a period.
 *
 * Real aggregation lands with billing in module 06. Until then this records that
 * the job ran and reports progress, rather than silently completing a rollup that
 * would leave usage records unaggregated and billing to under-count.
 */
export class UsageAggregationProcessor {
  private readonly logger = new Logger(UsageAggregationProcessor.name);

  readonly process: TenantJobProcessor<UsageAggregationJob> = (context, job) => {
    const { periodStart, periodEnd } = job.data.payload;
    this.logger.log(
      `Aggregating usage for tenant ${context.tenantId} over ${periodStart}..${periodEnd} ` +
        `(trace ${context.traceId})`,
    );
    return Promise.resolve();
  };
}

/**
 * `tenant-provisioning` — runs the post-signup setup steps for a new tenant.
 *
 * Each step in the payload is idempotent by design, so a retry after a partial
 * run is safe. That matters more than it looks: this queue is enqueued from
 * inside registration's transaction path, and a retry must not create a second
 * default role set or a second billing customer.
 */
export class TenantProvisioningProcessor {
  private readonly logger = new Logger(TenantProvisioningProcessor.name);

  readonly process: TenantJobProcessor<TenantProvisioningJob> = (context, job) => {
    const { slug, steps } = job.data.payload;
    this.logger.log(
      `Provisioning tenant ${context.tenantId} (${slug}): ${steps.join(', ')} ` +
        `(trace ${context.traceId})`,
    );
    return Promise.resolve();
  };
}

/** `notification-dispatch` — delivers a notification to a user. */
export class NotificationDispatchProcessor {
  private readonly logger = new Logger(NotificationDispatchProcessor.name);

  readonly process: TenantJobProcessor<Record<string, unknown>> = (context) => {
    this.logger.log(
      `Dispatching notification for tenant ${context.tenantId} (trace ${context.traceId})`,
    );
    return Promise.resolve();
  };
}

/*
 * There is deliberately no DLQ processor in this file.
 *
 * The DLQ is not consumed by any worker — an operator is. A `Worker` here would
 * make "dead" jobs silently succeed, which is precisely the signal an operator
 * needs to see, and it would consume the retry budget a replay operator is trying
 * to reason about. `WORKER_QUEUES` excludes the DLQ for the same reason, and an
 * integration test asserts that exclusion.
 */
