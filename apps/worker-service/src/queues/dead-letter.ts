/**
 * Dead Letter Queue routing.
 *
 * A job that exhausts its retry budget is copied onto its tenant's DLQ rather than
 * simply left in the failed set. The distinction matters operationally: BullMQ's
 * failed set is per queue and trimmed by `removeOnFail`, so a job that falls out
 * of that window is gone, with no record that it ever ran. The DLQ is explicit,
 * retained until an operator acts, and namespaced per tenant so replaying one
 * tenant's backlog cannot touch another's.
 *
 * DLQ entries are namespaced by tenant for the same reason as working queues — a
 * poison job must not be able to occupy another tenant's DLQ and slow an operator
 * working through an unrelated incident.
 */
import { Logger } from '@nestjs/common';
import type { Job, JobsOptions } from 'bullmq';
import {
  DEFAULT_JOB_OPTIONS,
  DLQ_JOB,
  DLQ_REASON,
  type BaseJob,
  type DeadLetterJobPayload,
  type DlqReason,
  type QueueName,
} from '@orbitoz/shared-types';
import type { TenantQueueRegistry } from './tenant-queue.js';
import { isRetryable } from '../context/job-context.js';

/** What the failed-job handler needs to know about the job that just failed. */
export interface DeadLetterDecision {
  readonly shouldDeadLetter: boolean;
  readonly reason: DlqReason | null;
}

/**
 * Decides whether a failed job belongs in the DLQ.
 *
 * Three cases, in priority order:
 *
 *  1. **No tenant id.** The payload could not be attributed to a tenant, so
 *     there is no namespace to file it under. It cannot be dead-lettered — the
 *     DLQ is per-tenant and putting an unattributable job in an arbitrary
 *     tenant's DLQ would be a lie about where it came from. BullMQ's failed set
 *     is the only record, and `removeOnFail` bounds it.
 *  2. **Non-retryable failure.** Went straight to the DLQ, skipping the retry
 *     budget entirely.
 *  3. **Budget exhausted.** `attemptsMade` has reached `attempts`, so no further
 *     attempts remain.
 *
 * Pure and synchronous, so the retry/DLQ policy is unit-testable without Redis.
 */
export function decideDeadLetter(
  job: { readonly data: unknown; readonly attemptsMade: number; readonly opts?: JobsOptions },
  error: unknown,
): DeadLetterDecision {
  const tenantId = readTenantId(job.data);
  if (tenantId === null) {
    return { shouldDeadLetter: false, reason: null };
  }

  if (!isRetryable(error)) {
    return { shouldDeadLetter: true, reason: DLQ_REASON.NonRetryable };
  }

  const budget = job.opts?.attempts ?? DEFAULT_JOB_OPTIONS.attempts;
  if (job.attemptsMade >= budget) {
    return { shouldDeadLetter: true, reason: DLQ_REASON.Exhausted };
  }

  return { shouldDeadLetter: false, reason: null };
}

/**
 * Reads a tenant id out of a payload without validating the rest of it.
 *
 * Deliberately permissive: this runs on a payload that has just failed, possibly
 * precisely *because* it is malformed. The DLQ needs only enough to pick a
 * namespace.
 */
function readTenantId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const tenantId = (data as { readonly tenantId?: unknown }).tenantId;
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : null;
}

/**
 * Copies a failed job onto its tenant's DLQ.
 *
 * Injected with the registry rather than a single queue, because the destination
 * namespace depends on the job that failed — and the job is exactly the input we
 * cannot trust to contain a valid tenant id.
 */
export class DeadLetterRouter {
  private readonly logger = new Logger(DeadLetterRouter.name);

  constructor(private readonly registry: TenantQueueRegistry) {}

  /**
   * Routes a failure to the DLQ when the policy says it belongs there.
   *
   * @returns the DLQ job id when routed, `null` when not.
   */
  async route(job: Job<BaseJob<unknown>>, error: unknown): Promise<string | null> {
    const decision = decideDeadLetter(job, error);
    if (!decision.shouldDeadLetter || decision.reason === null) return null;

    const tenantId = readTenantId(job.data);
    if (tenantId === null) return null;

    const payload: DeadLetterJobPayload = {
      sourceQueue: job.queueName as QueueName,
      sourceJobName: job.name,
      sourceJobId: job.id ?? 'unknown',
      reason: decision.reason,
      failure: describeFailure(error, job.attemptsMade),
      original: job.data,
    };

    try {
      const dlq = this.registry.deadLetterQueue<DeadLetterJobPayload>(tenantId);
      const dead = await dlq.add(DLQ_JOB.Dead, payload);
      this.logger.error(
        `Job ${payload.sourceJobId} (${payload.sourceQueue}/${payload.sourceJobName}) for tenant ` +
          `${tenantId} was dead-lettered (${decision.reason}): ${payload.failure.message}`,
      );
      return dead.id ?? null;
    } catch (routeError) {
      // The original job is already dead at this point, so a routing failure is
      // the only remaining trace of it. Log loudly — the alternative is a job
      // that vanished with no record anywhere.
      this.logger.error(
        `Failed to dead-letter job ${payload.sourceJobId} for tenant ${tenantId}: ` +
          `${routeError instanceof Error ? routeError.message : String(routeError)}`,
      );
      return null;
    }
  }
}

/** Normalises a thrown value into the DLQ's failure shape. */
function describeFailure(error: unknown, attemptsMade: number): DeadLetterJobPayload['failure'] {
  const isError = error instanceof Error;
  return {
    name: isError ? error.name : typeof error,
    message: isError ? error.message : String(error),
    attempts: attemptsMade,
    failedAt: new Date().toISOString(),
    retryable: isRetryable(error),
  };
}

/**
 * Replays a DLQ job back onto the queue it came from.
 *
 * The point of the DLQ is that recovery is a deliberate act, so this is explicit
 * rather than automatic: an operator decides which tenant's backlog to replay,
 * and the job returns to its original queue with a fresh retry budget.
 *
 * `foundInTenant` is required, and it is the security-relevant parameter. It is
 * the namespace the entry was actually read from — the DLQ the operator was
 * looking at — and it must match the envelope's own `tenantId`.
 *
 * Without that check the function would derive the target tenant from
 * untrusted, operator-editable payload alone, so a DLQ entry edited in Redis to
 * carry another tenant's id would replay *that* tenant's job into that tenant's
 * queue: anyone able to write to a DLQ could inject work into an arbitrary
 * tenant's namespace while appearing to be clearing a backlog. The queue name
 * cannot be forged past the registry's id checks, so this is the one boundary
 * worth checking explicitly.
 *
 * @throws {DeadLetterReplayError} when the entry has no usable tenant, or names a
 *   tenant other than the DLQ it was found in.
 */
export async function replayDeadLetter(
  registry: TenantQueueRegistry,
  entry: DeadLetterJobPayload,
  foundInTenant: string,
): Promise<string> {
  const tenantId = entry.original?.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new DeadLetterReplayError('DLQ entry has no tenant id to replay under.');
  }
  if (!isValidNamespaceId(tenantId)) {
    throw new DeadLetterReplayError(
      `DLQ entry tenant id ${JSON.stringify(tenantId)} is not a usable namespace.`,
    );
  }
  if (tenantId !== foundInTenant) {
    throw new DeadLetterReplayError(
      `Refusing to replay an entry claiming tenant ${JSON.stringify(tenantId)} ` +
        `from ${JSON.stringify(foundInTenant)}'s DLQ: the entry was edited or misfiled, ` +
        'and replaying it would enqueue work in another tenant namespace.',
    );
  }

  const queue = registry.queue<unknown>(tenantId, entry.sourceQueue);
  const replayed = await queue.add(entry.sourceJobName, entry.original, DEFAULT_JOB_OPTIONS);

  return replayed.id ?? 'unknown';
}

export class DeadLetterReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadLetterReplayError';
  }
}

/** Mirrors `assertTenantIdShape`'s rule, kept local to avoid a cycle. */
function isValidNamespaceId(tenantId: string): boolean {
  return !/[:{}\s]/.test(tenantId);
}
