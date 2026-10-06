/**
 * Human-in-the-loop approvals: create a gated job, show it, decide it, resume it.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE WHOLE MODULE IN ONE PARAGRAPH
 * ---------------------------------------------------------------------------
 * Creating an approval writes two rows and **no queue job**. The `inference_jobs`
 * row lands as `AWAITING_APPROVAL` and the `approval_requests` row as `PENDING`;
 * nothing is enqueued, so no worker slot is held for as long as the human takes
 * to decide. A decision is two short transactions with an enqueue between them.
 * Approving enqueues the job; rejecting cancels the row. Either way the paused
 * task resolves without a single BullMQ pause having existed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ENQUEUE SITS *BETWEEN* TWO TRANSACTIONS
 * ---------------------------------------------------------------------------
 * Postgres and Redis cannot commit together, and the order matters in both
 * directions:
 *
 *   enqueue-then-commit  The worker could pick the job up and start calling a
 *                        provider before the decision is durable. A rollback then
 *                        leaves a job that ran — and billed — against a row that
 *                        says it was never approved.
 *   commit-then-enqueue  A crash between the two leaves an approved request that
 *                        nothing will run. Recoverable, because the retry is
 *                        idempotent.
 *
 * So: commit, enqueue, commit. The same split `inference-store.ts` uses to keep a
 * 30s provider call out of a 10s transaction, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY IS TWO INDEPENDENT GATES, NOT ONE
 * ---------------------------------------------------------------------------
 * A webhook sender retries. A person double-clicks. Two requests race. Each of
 * those has to be safe, and one mechanism cannot cover all of them:
 *
 *   1. `updateMany({ status: PENDING })` — exactly one caller can move the row out
 *      of `PENDING`, because Postgres decides that atomically. This is the gate
 *      that makes "one decision per link" true no matter how many callers arrive.
 *   2. The BullMQ `jobId` is the `inference_jobs.id`, and BullMQ ignores an
 *      `add` whose id already exists. This is what makes *re-dispatch* safe.
 *
 * Neither subsumes the other. Gate 1 alone would let a crash-after-commit drop
 * the resume forever; gate 2 alone would let a second caller observe a decision
 * as "new" because it re-read a row it had not yet written.
 *
 * ---------------------------------------------------------------------------
 * WHY `dispatchedAt` IS NOT `decidedAt`
 * ---------------------------------------------------------------------------
 * They are separate so the crash window above is recoverable: a retried webhook
 * that finds `APPROVED` with `dispatchedAt` still null re-attempts the enqueue,
 * and gate 2 makes that a no-op if it already succeeded. Collapsing them would
 * mean a lost response to a successful approval is a job that never runs.
 *
 * ---------------------------------------------------------------------------
 * TENANT SCOPE IS STRUCTURAL, NOT A COMPARISON
 * ---------------------------------------------------------------------------
 * The token lookup runs inside the request's tenant-pinned transaction, so RLS
 * decides visibility. A token minted for tenant B, presented on tenant A's
 * subdomain, is not "compared and rejected" — it is simply not returned, and the
 * handler raises `APPROVAL_NOT_FOUND` from a null. That is why there is no
 * cross-tenant branch anywhere in this file, and why one cannot be added by
 * accident.
 */
import { Logger } from '@nestjs/common';
import {
  ApprovalStatus,
  asJobId,
  asRequestId,
  asTenantId,
  asUserId,
  JobStatus,
  TERMINAL_JOB_STATUSES,
  approvalDecisionPath,
  approvalViewPath,
  type AiProvider,
  type ApprovalAction,
  type ApprovalActionGrant,
  type ApprovalDecisionResult,
  type ApprovalRequestCreated,
  type ApprovalSummary,
  type ApprovalView,
  type BaseJob,
  type InferenceJobPayload,
  type InferenceMessage,
  type RoutingStrategy,
  type TenantId,
} from '@orbitoz/shared-types';
import type { Prisma, TenantScopedTransaction } from '@orbitoz/database';
import type { TenantTransaction } from '../tenancy/tenant-transaction.js';
import type { EnvService } from '../config/env.service.js';
import { APPROVAL_RESUME_QUEUE, type QueueProducer } from '../queues/queue-producer.js';
import type { ApprovalSignatureService } from './approval-signature.service.js';
import type { ApprovalTokenService } from './approval-token.service.js';
import {
  ApprovalDispatchFailedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalSignatureExpiredError,
  ApprovalSignatureInvalidError,
} from './approval.errors.js';
import type { RequestFingerprint } from '../auth/auth.types.js';

/** Client metadata, reused from auth so the columns are truncated identically. */
export interface CreateApprovalInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly model: string;
  readonly messages: readonly InferenceMessage[];
  readonly provider: AiProvider | null;
  /** Null means "use the tenant's default", resolved by the worker at run time. */
  readonly strategy: RoutingStrategy | null;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  readonly topP: number | null;
  readonly stopSequences: readonly string[] | null;
  readonly responseSchema: Readonly<Record<string, unknown>> | null;
  readonly fanout: number;
  readonly idempotencyKey: string | null;
  readonly maxCostUsd: number | null;
  readonly conversationId: string | null;
  readonly fingerprint: RequestFingerprint;
}

export interface DecideApprovalInput {
  readonly tenantId: string;
  readonly token: string;
  readonly action: ApprovalAction;
  readonly timestamp: string;
  readonly signature: unknown;
  readonly note: string | null;
  readonly fingerprint: RequestFingerprint;
  readonly requestId: string;
}

/** The subset of `approval_requests` this service reads and writes. */
const APPROVAL_SELECT = {
  id: true,
  jobId: true,
  jobName: true,
  status: true,
  payload: true,
  requestedByUserId: true,
  expiresAt: true,
  decidedAt: true,
  decisionNote: true,
  dispatchedAt: true,
  createdAt: true,
} as const;

interface ApprovalRow {
  readonly id: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly status: ApprovalStatus;
  readonly payload: Prisma.JsonValue;
  readonly requestedByUserId: string;
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly dispatchedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * What the first transaction concluded.
 *
 * Deliberately a value rather than a thrown error: an expiry that is *detected*
 * must still be *recorded*, and an exception raised inside `transactions.run`
 * would roll that write back — leaving a dead link looking live forever.
 */
type DecisionOutcome =
  | { readonly kind: 'decided'; readonly approval: ApprovalRow; readonly recorded: boolean }
  | { readonly kind: 'expired'; readonly expiresAt: Date }
  | { readonly kind: 'not_found' };

export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly transactions: TenantTransaction,
    private readonly tokens: ApprovalTokenService,
    private readonly signatures: ApprovalSignatureService,
    private readonly producer: QueueProducer,
    private readonly env: EnvService,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Create                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Parks a job pending approval and mints its link.
   *
   * Both rows are written in one transaction: a job with no approval row is an
   * orphan nothing can ever resume, and an approval row with no job is a link
   * that approves nothing. Neither state is reachable from here.
   */
  async create(input: CreateApprovalInput): Promise<ApprovalRequestCreated> {
    const ttlMs = this.env.value.approvals.requestTtlSeconds * 1_000;
    const expiresAt = new Date(Date.now() + ttlMs);

    const payload: InferenceJobPayload = {
      model: input.model,
      provider: input.provider,
      // A null strategy is resolved by the worker against the tenant's default at
      // run time, so the snapshot records the *absence* of a choice rather than
      // freezing today's default into a link that may be approved next week.
      strategy: input.strategy ?? ('BALANCED' satisfies RoutingStrategy),
      messages: input.messages,
      options: {
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        topP: input.topP,
        stopSequences: input.stopSequences,
        responseSchema: input.responseSchema,
      },
      fanout: input.fanout,
      idempotencyKey: input.idempotencyKey,
      maxCostUsd: input.maxCostUsd,
    };

    const issued = this.tokens.issue();

    const created = await this.transactions.run(input.tenantId, async () => {
      const tx = this.transactions.active;

      const job = await tx.inferenceJob.create({
        data: {
          // Explicit despite the extension injecting it, for the reason given in
          // `auth.service.ts`: a missing tenantId on a write must be a loud
          // NOT NULL violation, never a silent row with no tenant.
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          requestedModel: input.model,
          provider: input.provider,
          routingStrategy: payload.strategy,
          status: JobStatus.AwaitingApproval,
          requestPayload: input.messages as unknown as Prisma.InputJsonValue,
          errorCode: null,
          errorMessage: null,
        },
        select: { id: true },
      });

      const approval = await tx.approvalRequest.create({
        data: {
          tenantId: input.tenantId,
          tokenHash: issued.tokenHash,
          jobId: job.id,
          payload: payload as unknown as Prisma.InputJsonValue,
          requestedByUserId: input.userId,
          expiresAt,
        },
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          actorId: input.userId,
          action: 'APPROVAL_REQUESTED',
          target: approval.id,
          ipAddress: input.fingerprint.ipAddress,
          userAgent: input.fingerprint.userAgent,
          requestId: input.requestId,
          metadata: { jobId: job.id, model: input.model, expiresAt: expiresAt.toISOString() },
        },
        select: { tenantId: true },
      });

      return { approvalId: approval.id, jobId: job.id };
    });

    return {
      approvalId: created.approvalId,
      jobId: created.jobId,
      token: issued.token,
      status: ApprovalStatus.Pending,
      expiresAt: expiresAt.toISOString(),
      approvalPath: approvalDecisionPath(issued.token),
      viewPath: approvalViewPath(issued.token),
      requestId: input.requestId as ApprovalRequestCreated['requestId'],
    };
  }

  /* ------------------------------------------------------------------ */
  /* View                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The page an approver opens.
   *
   * Token-gated but **not** signature-gated, and that asymmetry is intentional:
   * the signature exists to stop the *decision* being tampered with, and a
   * read-only view has nothing to tamper with. Requiring one would only make the
   * link unusable in a browser. Expiry is reported rather than enforced here — an
   * approver who sees "expired" learns why their click will not work, which is
   * strictly better than a page that silently renders as if it were live.
   */
  async getView(tenantId: string, token: string): Promise<ApprovalView> {
    const approval = await this.findByToken(tenantId, token);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const grants: Record<ApprovalAction, ApprovalActionGrant> = {
      APPROVE: {
        action: 'APPROVE',
        timestamp,
        signature: this.signatures.sign(token, 'APPROVE', Number(timestamp)),
      },
      REJECT: {
        action: 'REJECT',
        timestamp,
        signature: this.signatures.sign(token, 'REJECT', Number(timestamp)),
      },
    };

    return {
      approval: toSummary(approval, tenantId),
      actions: { approve: grants.APPROVE, reject: grants.REJECT },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Decide                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Records a decision and, if it was an approval, resumes the job.
   *
   * The signature is verified **before** any database work, and it is verified
   * against the token, the action and the timestamp together. Verifying it later
   * would mean an unauthenticated caller could make the database do work first,
   * and splitting the inputs would let a grant captured from the approve button
   * authorise a rejection.
   */
  async decide(input: DecideApprovalInput): Promise<ApprovalDecisionResult> {
    const verification = this.signatures.verify(
      input.token,
      input.action,
      input.timestamp,
      input.signature,
    );
    if (!verification.ok) {
      // `timestamp_out_of_range` is the one rejection with an actionable remedy —
      // reload the page for a fresh grant — so it gets its own code. Every other
      // rejection is one opaque 401, because naming the failing check would tell
      // a caller how to work around it.
      if (verification.reason === 'timestamp_out_of_range') {
        throw new ApprovalSignatureExpiredError();
      }
      throw new ApprovalSignatureInvalidError();
    }

    const outcome = await this.recordDecision(input);
    if (outcome.kind === 'not_found') throw new ApprovalNotFoundError();
    if (outcome.kind === 'expired') throw new ApprovalExpiredError(outcome.expiresAt);

    // An expiry recorded by an *earlier* click takes the same route out as one
    // detected here. Reporting a 410 the first time and a 200-with-EXPIRED the second
    // would leave a retrying client unable to tell a finished decision from a live
    // one, and would invite it to keep retrying a link that will never work.
    if (outcome.approval.status === ApprovalStatus.Expired) {
      throw new ApprovalExpiredError(outcome.approval.expiresAt);
    }

    // A rejection never enqueues, so the recorded state is already final.
    if (outcome.approval.status !== ApprovalStatus.Approved) {
      const jobStatus = await this.jobStatusOf(input.tenantId, outcome.approval.jobId);
      return {
        approval: toSummary(outcome.approval, input.tenantId),
        outcome: outcome.recorded ? 'recorded' : 'already_decided',
        jobStatus,
        dispatched: false,
        requestId: input.requestId as ApprovalDecisionResult['requestId'],
      };
    }

    // Already resumed by an earlier call that lost its response: nothing to do.
    if (outcome.approval.dispatchedAt !== null) {
      const jobStatus = await this.jobStatusOf(input.tenantId, outcome.approval.jobId);
      return {
        approval: toSummary(outcome.approval, input.tenantId),
        outcome: 'already_decided',
        jobStatus,
        dispatched: false,
        requestId: input.requestId as ApprovalDecisionResult['requestId'],
      };
    }

    // Outside every transaction — see the module comment on ordering.
    const enqueued = await this.dispatch(input.tenantId, outcome.approval, input.requestId);

    const settled = await this.settleDispatch(
      input.tenantId,
      outcome.approval.id,
      outcome.approval.jobId,
    );

    return {
      approval: toSummary(settled.approval, input.tenantId),
      // A replay that performed the enqueue reports `recorded` for the *resume*
      // as well, because this call is what made the job runnable. `dispatched`
      // distinguishes the two.
      outcome: enqueued ? 'recorded' : 'already_decided',
      jobStatus: settled.jobStatus,
      dispatched: enqueued,
      requestId: input.requestId as ApprovalDecisionResult['requestId'],
    };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The first transaction: resolve, expire, or claim the decision.
   *
   * Returns an outcome rather than throwing, because the expiry path has a write
   * to commit before the caller learns about it.
   */
  private async recordDecision(input: DecideApprovalInput): Promise<DecisionOutcome> {
    const tokenHash = this.tokens.hash(input.token);
    const target = input.action === 'APPROVE' ? ApprovalStatus.Approved : ApprovalStatus.Rejected;
    const now = new Date();

    return this.transactions.run(input.tenantId, async () => {
      const tx = this.transactions.active;

      const found = await tx.approvalRequest.findUnique({
        where: { tokenHash },
        select: APPROVAL_SELECT,
      });
      if (found === null) return { kind: 'not_found' } as const;
      const approval = found as ApprovalRow;

      if (approval.status === ApprovalStatus.Pending && approval.expiresAt <= now) {
        await this.expire(tx, input, approval, now);
        return { kind: 'expired', expiresAt: approval.expiresAt } as const;
      }

      if (approval.status !== ApprovalStatus.Pending) {
        return { kind: 'decided', approval, recorded: false } as const;
      }

      // Gate 1. The `status: PENDING` predicate is what makes this the single
      // point of arbitration: Postgres decides the winner of a concurrent race,
      // and every loser sees `count === 0`.
      const claimed = await tx.approvalRequest.updateMany({
        where: {
          tenantId: input.tenantId,
          id: approval.id,
          status: ApprovalStatus.Pending,
          expiresAt: { gt: now },
        },
        data: {
          status: target,
          decidedAt: now,
          decisionNote: input.note,
          decisionIp: input.fingerprint.ipAddress,
          decisionUserAgent: input.fingerprint.userAgent,
          decisionTraceId: input.requestId,
        },
      });

      if (claimed.count === 0) {
        // Lost the race, or the row changed under us. Re-read so the caller is
        // told what actually happened instead of what it intended.
        const fresh = await tx.approvalRequest.findUnique({
          where: { tenantId_id: { tenantId: input.tenantId, id: approval.id } },
          select: APPROVAL_SELECT,
        });
        if (fresh === null) return { kind: 'not_found' } as const;
        return { kind: 'decided', approval: fresh, recorded: false } as const;
      }

      if (target === ApprovalStatus.Rejected) {
        await this.cancelJob(tx, input, approval, now);
      }

      const settled = await tx.approvalRequest.findUnique({
        where: { tenantId_id: { tenantId: input.tenantId, id: approval.id } },
        select: APPROVAL_SELECT,
      });

      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          // No authenticated principal: this route is public and the approver is
          // identified by the token, not by a session. The audit trail records
          // the IP and user agent instead, plus a token fragment below so a
          // support question ("who clicked this?") has something to match on
          // without writing a working credential into a log.
          actorId: null,
          action: target === ApprovalStatus.Approved ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
          target: approval.id,
          ipAddress: input.fingerprint.ipAddress,
          userAgent: input.fingerprint.userAgent,
          requestId: input.requestId,
          metadata: { jobId: approval.jobId },
        },
        select: { tenantId: true },
      });

      // `settled` cannot be null: the row was just updated in this transaction.
      return { kind: 'decided', approval: settled as ApprovalRow, recorded: true } as const;
    });
  }

  /** Marks an over-deadline request expired and cancels the job it gates. */
  private async expire(
    tx: TenantScopedTransaction,
    input: DecideApprovalInput,
    approval: ApprovalRow,
    now: Date,
  ): Promise<void> {
    await tx.approvalRequest.updateMany({
      where: {
        tenantId: input.tenantId,
        id: approval.id,
        status: ApprovalStatus.Pending,
      },
      data: { status: ApprovalStatus.Expired, decidedAt: now, decisionTraceId: input.requestId },
    });
    await this.cancelJob(tx, input, approval, now);

    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorId: null,
        action: 'APPROVAL_EXPIRED',
        target: approval.id,
        ipAddress: input.fingerprint.ipAddress,
        userAgent: input.fingerprint.userAgent,
        requestId: input.requestId,
        metadata: { jobId: approval.jobId },
      },
      select: { tenantId: true },
    });
  }

  /**
   * Cancels the gated job.
   *
   * `updateMany` guarded on a non-terminal status, for the reason
   * `inference-store.ts` gives: a cancel that arrives for a job that already
   * finished is a no-op rather than an exception, and it must not consume a
   * retry. A job that reached `SUCCEEDED` before the rejection arrived keeps its
   * result — the approver was too late, and overwriting a completed run would be
   * worse than the race.
   */
  private async cancelJob(
    tx: TenantScopedTransaction,
    input: DecideApprovalInput,
    approval: ApprovalRow,
    now: Date,
  ): Promise<void> {
    await tx.inferenceJob.updateMany({
      where: {
        tenantId: input.tenantId,
        id: approval.jobId,
        status: { notIn: [...TERMINAL_JOB_STATUSES] },
      },
      data: { status: JobStatus.Canceled, completedAt: now },
    });
  }

  /**
   * Puts the approved job onto the queue.
   *
   * `jobId` is the database job id, which is also the BullMQ job id. Two reasons
   * for the same value: the worker's `InferenceProcessor` reads `job.data.id` as
   * the row to run, so they cannot differ; and it makes the enqueue
   * self-deduplicating without inventing a second identifier.
   *
   * @throws {ApprovalDispatchFailedError} when Redis is unreachable. The decision
   *   stays committed with `dispatchedAt` null, so a retry resumes the job rather
   *   than losing it.
   */
  private async dispatch(
    tenantId: string,
    approval: ApprovalRow,
    requestId: string,
  ): Promise<boolean> {
    const envelope: BaseJob<InferenceJobPayload> = {
      id: asJobId(approval.jobId),
      tenantId: asTenantId(tenantId),
      // The requesting user, not the approver: the job was created by them and
      // the ambient scope on the worker side is meant to answer "whose work is
      // this". The approver has no user id, which is why this is not read from
      // the click.
      userId: asUserId(approval.requestedByUserId),
      traceId: asRequestId(requestId),
      enqueuedAt: new Date().toISOString(),
      attempt: 0,
      payload: approval.payload as unknown as InferenceJobPayload,
    };

    try {
      const created = await this.producer.enqueue({
        queue: APPROVAL_RESUME_QUEUE,
        jobName: approval.jobName,
        jobId: approval.jobId,
        envelope,
      });
      this.logger.log(
        `Approval ${approval.id} ${created ? 'dispatched' : 'already dispatched'} ` +
          `job ${approval.jobId}`,
      );
      return created;
    } catch (error) {
      // Deliberately a 503 outward. The decision is durable and the caller can
      // usefully retry; reporting this as a client error would tell a webhook
      // sender its request was malformed when in fact the queue is down.
      throw new ApprovalDispatchFailedError(
        approval.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * The second transaction: record that the resume happened, and make the job
   * runnable.
   *
   * The job's transition to `QUEUED` lives here rather than in the first
   * transaction on purpose. Moving it earlier would advertise the job as queued
   * during the window where the enqueue might still fail, and a reader would see
   * `QUEUED` for a job no worker will ever receive.
   *
   * `dispatchAttempts` counts reachings of Redis, including a deduplicated enqueue:
   * a request that keeps failing to resume shows up as a run of increments rather
   * than as an approval that silently did nothing.
   */
  private async settleDispatch(
    tenantId: string,
    approvalId: string,
    jobId: string,
  ): Promise<{ readonly approval: ApprovalRow; readonly jobStatus: JobStatus }> {
    return this.transactions.run(tenantId, async () => {
      const tx = this.transactions.active;

      await tx.approvalRequest.updateMany({
        where: {
          tenantId,
          id: approvalId,
          status: ApprovalStatus.Approved,
          dispatchedAt: null,
        },
        data: { dispatchedAt: new Date(), dispatchAttempts: { increment: 1 } },
      });

      const job = await tx.inferenceJob.updateMany({
        where: {
          tenantId,
          id: jobId,
          // Only a parked job is promoted. A job that somehow reached a terminal
          // state between approval and here keeps that state: the work is done,
          // and re-queueing it would re-bill the tenant.
          status: JobStatus.AwaitingApproval,
        },
        data: { status: JobStatus.Queued, queueJobId: jobId, startedAt: null },
      });

      const approval = await tx.approvalRequest.findUnique({
        where: { tenantId_id: { tenantId, id: approvalId } },
        select: APPROVAL_SELECT,
      });
      if (approval === null) {
        // Unreachable: the row was read in the previous transaction and this one
        // only runs microseconds later on the same tenant. Failing loudly beats
        // returning a summary of nothing.
        throw new ApprovalNotFoundError();
      }

      const jobStatus =
        job.count === 1 ? JobStatus.Queued : await this.readJobStatus(tx, tenantId, jobId);
      return { approval, jobStatus };
    });
  }

  private async jobStatusOf(tenantId: string, jobId: string): Promise<JobStatus> {
    return this.transactions.run(tenantId, async () => {
      const tx = this.transactions.active;
      return this.readJobStatus(tx, tenantId, jobId);
    });
  }

  private async readJobStatus(
    tx: TenantScopedTransaction,
    tenantId: string,
    jobId: string,
  ): Promise<JobStatus> {
    const row = await tx.inferenceJob.findUnique({
      where: { tenantId_id: { tenantId, id: jobId } },
      select: { status: true },
    });
    return row?.status ?? JobStatus.Canceled;
  }

  /** Resolves a token inside the tenant's scope. RLS is what makes it safe. */
  private async findByToken(tenantId: string, token: string): Promise<ApprovalRow> {
    const row = await this.transactions.run(tenantId, async () => {
      const tx = this.transactions.active;
      return tx.approvalRequest.findUnique({
        where: { tokenHash: this.tokens.hash(token) },
        select: APPROVAL_SELECT,
      });
    });
    if (row === null) throw new ApprovalNotFoundError();
    return row;
  }
}

/**
 * Reads a decision back as the shape the API returns.
 *
 * `model`, `strategy` and `maxCostUsd` come from the snapshotted payload rather
 * than from the `inference_jobs` row, so the page an approver sees is exactly
 * the work that will run — including if the tenant's catalogue changes in the
 * meantime.
 */
function toSummary(approval: ApprovalRow, tenantId: string): ApprovalSummary {
  const payload = approval.payload as unknown as InferenceJobPayload;
  return {
    approvalId: approval.id,
    jobId: approval.jobId,
    tenantId: tenantId as TenantId,
    status: approval.status,
    model: payload.model,
    strategy: payload.strategy,
    maxCostUsd: payload.maxCostUsd,
    requestedBy: asUserId(approval.requestedByUserId),
    requestedAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decisionNote: approval.decisionNote,
    dispatched: approval.dispatchedAt !== null,
  };
}
