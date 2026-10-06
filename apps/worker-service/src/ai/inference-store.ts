/**
 * The persistence port for one inference job.
 *
 * The runner is deliberately written against this interface rather than against
 * Prisma, for two reasons that both matter here:
 *
 *  1. **The provider call must not run inside a transaction.** A Postgres
 *     interactive transaction has a short timeout (10s here) and holds a pooled
 *     connection; a provider call can take 30s. So the job's life is split into
 *     short transactions — start, load routing inputs, finish — and the long part
 *     runs between them. The `withTenant` call sites below make that split
 *     explicit instead of hiding it behind one big callback.
 *  2. **It is testable without Postgres.** A unit test substitutes an in-memory
 *     store and asserts the orchestration, which is the part with the failover and
 *     cost logic. The SQL is then a thin, reviewable mapping.
 */
import {
  JobStatus,
  PLAN_ENTITLEMENTS,
  TERMINAL_JOB_STATUSES,
  type AiProvider,
  type PlanEntitlement,
  type RoutingStrategy,
} from '@orbitoz/shared-types';
import type { Prisma, TenantScopedTransaction } from '@orbitoz/database';
import type { AgentAttempt, RoutableModel } from '@orbitoz/ai-engine';
import type { WorkerDatabase } from '../worker/worker-database.js';

/** The subset of an `inference_jobs` row the runner needs to make decisions. */
export interface InferenceJobRecord {
  readonly id: string;
  readonly conversationId: string | null;
  readonly status: JobStatus;
  readonly requestedModel: string;
  readonly provider: string | null;
  readonly strategy: RoutingStrategy;
}

/** A catalogue entry plus the tenant's reference to the credential for it. */
export interface CatalogueEntry {
  readonly model: RoutableModel;
  /** `tenant_providers.credential_ref`; null means "use the provider default". */
  readonly credentialRef: string | null;
}

export interface RoutingInputs {
  readonly entitlements: PlanEntitlement;
  readonly catalogue: readonly CatalogueEntry[];
}

/** Start outcome. `missing`, `terminal` and `awaiting_approval` are all no-ops. */
export type StartResult =
  | { readonly kind: 'ready'; readonly job: InferenceJobRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'terminal'; readonly status: JobStatus }
  | { readonly kind: 'awaiting_approval' };

export interface UsageInput {
  readonly model: string;
  readonly provider: string;
  readonly strategy: RoutingStrategy;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsdMicros: number;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly errorCode: string | null;
}

export interface SuccessOutcome {
  readonly provider: string;
  readonly model: string;
  readonly content: string;
  readonly finishReason: string | null;
  readonly structured: unknown;
  readonly latencyMs: number;
  readonly attempts: readonly AgentAttempt[];
  readonly usage: UsageInput;
}

export interface FailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly latencyMs: number;
  readonly attempts: readonly AgentAttempt[];
  readonly usage: UsageInput;
  /**
   * True when this delivery is the job's last, so the row may be terminal.
   *
   * `FAILED` is terminal, and `startJob` refuses to restart a terminal job — so
   * writing it on an intermediate attempt would silently disable BullMQ's retry.
   * A non-terminal failure is recorded as `QUEUED`, keeping the error visible
   * while leaving the job runnable.
   */
  readonly terminal: boolean;
}

export interface InferenceStore {
  /** Reads the job, refuses to restart a terminal one, and marks it RUNNING. */
  startJob(tenantId: string, jobId: string): Promise<StartResult>;
  loadRoutingInputs(tenantId: string): Promise<RoutingInputs>;
  markCanceled(tenantId: string, jobId: string): Promise<void>;
  finishSuccess(tenantId: string, jobId: string, outcome: SuccessOutcome): Promise<void>;
  finishFailure(tenantId: string, jobId: string, outcome: FailureOutcome): Promise<void>;
}

export class PrismaInferenceStore implements InferenceStore {
  constructor(private readonly db: WorkerDatabase) {}

  async startJob(tenantId: string, jobId: string): Promise<StartResult> {
    return this.db.withTenant(tenantId, async (tx) => {
      const job = await tx.inferenceJob.findUnique({
        where: { tenantId_id: { tenantId, id: jobId } },
        select: {
          id: true,
          conversationId: true,
          status: true,
          requestedModel: true,
          provider: true,
          routingStrategy: true,
        },
      });

      if (job === null) return { kind: 'missing' };

      // A completed job must never be re-run: BullMQ's at-least-once delivery
      // means a duplicate delivery of a finished job is normal, and re-running it
      // would re-bill the tenant and overwrite the stored answer.
      if (TERMINAL_JOB_STATUSES.includes(job.status)) {
        return { kind: 'terminal', status: job.status };
      }

      // A job waiting on a human is not authorised to run. The approval webhook
      // creates the queue entry, so a job reaching here in this state means
      // something enqueued it early — a producer bug, a stale replay, or a job
      // id collision. Refusing here means the mistake costs a log line instead of
      // a provider call and an invoice, which is the whole reason the row is the
      // authority rather than the queue.
      if (job.status === JobStatus.AwaitingApproval) {
        return { kind: 'awaiting_approval' };
      }

      await tx.inferenceJob.update({
        where: { tenantId_id: { tenantId, id: jobId } },
        data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
      });

      return {
        kind: 'ready',
        job: {
          id: job.id,
          conversationId: job.conversationId,
          status: job.status,
          requestedModel: job.requestedModel,
          provider: job.provider,
          strategy: job.routingStrategy,
        },
      };
    });
  }

  async loadRoutingInputs(tenantId: string): Promise<RoutingInputs> {
    return this.db.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true },
      });
      if (tenant === null) {
        throw new Error(`Tenant ${tenantId} does not exist; cannot route an inference job for it.`);
      }

      const [models, overrides, reliability] = await Promise.all([
        tx.providerModel.findMany({ where: { isEnabled: true } }),
        tx.tenantProvider.findMany(),
        this.loadReliability(tx),
      ]);

      const overrideByModelId = new Map(overrides.map((override) => [override.modelId, override]));

      const catalogue: CatalogueEntry[] = models.map((model) => {
        const override = overrideByModelId.get(model.id);
        const key = `${model.provider}:${model.modelId}`;
        const routable: RoutableModel = {
          modelId: model.modelId,
          provider: model.provider,
          displayName: model.displayName,
          capabilities: model.capabilities,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          inputCostPerMTokens: model.inputCostPerMTokens,
          outputCostPerMTokens: model.outputCostPerMTokens,
          qualityScore: model.qualityScore,
          latencyScore: model.latencyScore,
          isDeprecated: model.isDeprecated,
          tenantStatus: override?.status ?? null,
          tenantWeight: override?.weight ?? null,
          priceMultiplierBps: override?.priceMultiplierBps ?? null,
          reliabilityScore: reliability.get(key) ?? null,
        };
        return { model: routable, credentialRef: override?.credentialRef ?? null };
      });

      return { entitlements: PLAN_ENTITLEMENTS[tenant.plan], catalogue };
    });
  }

  async markCanceled(tenantId: string, jobId: string): Promise<void> {
    await this.db.withTenant(tenantId, async (tx) => {
      // `updateMany` rather than `update`: a cancel that arrives for a job whose
      // row is already gone is a no-op, not an exception, and it must not consume
      // a retry. It also refuses to reopen a finished job.
      await tx.inferenceJob.updateMany({
        where: { tenantId, id: jobId, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
        data: { status: 'CANCELED', completedAt: new Date() },
      });
    });
  }

  async finishSuccess(tenantId: string, jobId: string, outcome: SuccessOutcome): Promise<void> {
    await this.db.withTenant(tenantId, async (tx) => {
      await tx.inferenceJob.update({
        where: { tenantId_id: { tenantId, id: jobId } },
        data: {
          status: 'SUCCEEDED',
          provider: outcome.provider,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          costUsdMicros: outcome.usage.costUsdMicros,
          latencyMs: outcome.latencyMs,
          responsePayload: {
            content: outcome.content,
            finishReason: outcome.finishReason,
            structured: outcome.structured,
          } as Prisma.InputJsonValue,
          errorCode: null,
          errorMessage: null,
          completedAt: new Date(),
        },
      });

      await this.writeAttempts(tx, tenantId, jobId, outcome.attempts);
      await tx.usageRecord.create({
        data: {
          tenantId,
          jobId,
          model: outcome.usage.model,
          provider: outcome.usage.provider,
          strategy: outcome.usage.strategy,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          costUsdMicros: outcome.usage.costUsdMicros,
          latencyMs: outcome.usage.latencyMs,
          success: true,
          errorCode: null,
        },
      });
    });
  }

  async finishFailure(tenantId: string, jobId: string, outcome: FailureOutcome): Promise<void> {
    await this.db.withTenant(tenantId, async (tx) => {
      await tx.inferenceJob.update({
        where: { tenantId_id: { tenantId, id: jobId } },
        data: {
          status: outcome.terminal ? 'FAILED' : 'QUEUED',
          errorCode: outcome.errorCode,
          // The column is VARCHAR(2000); an unbounded provider message would fail
          // the update that is meant to record the failure.
          errorMessage: outcome.errorMessage.slice(0, 2_000),
          latencyMs: outcome.latencyMs,
          ...(outcome.terminal ? { completedAt: new Date() } : {}),
        },
      });

      await this.writeAttempts(tx, tenantId, jobId, outcome.attempts);
      // Usage carries the cost actually incurred. Usually zero for a failure, but
      // not always: a response that was generated and then failed schema
      // validation did consume tokens, and recording zero would under-bill it.
      await tx.usageRecord.create({
        data: {
          tenantId,
          jobId,
          model: outcome.usage.model,
          provider: outcome.usage.provider,
          strategy: outcome.usage.strategy,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          costUsdMicros: outcome.usage.costUsdMicros,
          latencyMs: outcome.usage.latencyMs,
          success: false,
          errorCode: outcome.errorCode,
        },
      });
    });
  }

  private async writeAttempts(
    tx: TenantScopedTransaction,
    tenantId: string,
    jobId: string,
    attempts: readonly AgentAttempt[],
  ): Promise<void> {
    if (attempts.length === 0) return;

    await tx.providerAttempt.createMany({
      data: attempts.map((attempt, index) => ({
        tenantId,
        jobId,
        // 1-based: attempt 0 reads as "no attempt" in a report.
        attemptNo: index + 1,
        provider: attempt.provider,
        model: attempt.model,
        success: attempt.success,
        latencyMs: attempt.latencyMs,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage === null ? null : attempt.errorMessage.slice(0, 2_000),
      })),
      // A retried job re-writes the same (jobId, attemptNo) rows. Skipping the
      // duplicates keeps the audit trail append-only rather than erroring on the
      // second attempt to record the same failure.
      skipDuplicates: true,
    });
  }

  /**
   * Observed success rate per provider/model, 0..10000.
   *
   * Null for a model with no attempts, which the router treats as neutral rather
   * than as zero: a model nobody has used has not failed.
   */
  private async loadReliability(tx: TenantScopedTransaction): Promise<Map<string, number>> {
    const grouped = await tx.providerAttempt.groupBy({
      by: ['provider', 'model', 'success'],
      _count: { _all: true },
    });

    const totals = new Map<string, { success: number; failure: number }>();
    for (const row of grouped) {
      const key = `${row.provider}:${row.model}`;
      const entry = totals.get(key) ?? { success: 0, failure: 0 };
      const count = row._count._all;
      if (row.success) entry.success += count;
      else entry.failure += count;
      totals.set(key, entry);
    }

    const scores = new Map<string, number>();
    for (const [key, { success, failure }] of totals) {
      const attempts = success + failure;
      if (attempts === 0) continue;
      scores.set(key, Math.round((success / attempts) * 10_000));
    }
    return scores;
  }
}

/** Narrow the Prisma provider string to the `AiProvider` enum it mirrors. */
export function asAiProvider(provider: string): AiProvider {
  // The column is a free-form VarChar, so the cast is a runtime claim, not a
  // type-level one. The provider factory validates it by refusing to build a
  // client for an unknown provider.
  return provider as AiProvider;
}
