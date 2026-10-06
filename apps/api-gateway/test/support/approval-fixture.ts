/**
 * Real infrastructure for the approval integration suite: a real Postgres behind a
 * real non-owner role, and a real Redis behind the production key prefix.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRODUCTION KEY PREFIX, NOT A RUN-SUFFIXED ONE
 * ---------------------------------------------------------------------------
 * The worker's test harness appends a random run id to every queue prefix, which is
 * how three files share one Redis without colliding. `QueueProducer` cannot: it
 * derives its prefix from `tenantQueuePrefix(tenantId)` and nothing else, because
 * that function is the contract with the worker's subscription. Injecting a suffix
 * would mean adding a test-only parameter to production code to make a test pass —
 * and the property under test *is* that the producer and the consumer agree on that
 * prefix. A run suffix would hide exactly the disagreement that matters.
 *
 * Isolation therefore comes from the tenant id instead: every test mints its own
 * random UUID, so the keys it writes live under `orbitoz:{<uuid>}:queue:*` and
 * `cleanup()` removes exactly that namespace. The match pattern is built from the
 * test's own uuid, never a wildcard, so a bug in prefix construction cannot delete
 * anything belonging to another run.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TENANTS ARE DELETED AND NOT LEFT BEHIND
 * ---------------------------------------------------------------------------
 * The rows cascade from `tenants` (`onDelete: Cascade`), so deleting the tenant
 * removes the job, the approval, the audit rows and the payload snapshot in one
 * statement. That matters more than usual here: the payload snapshot is the
 * tenant's prompt text, and a test suite that leaves prompts in a development
 * database after a run that asserted they are isolated would be making a point
 * nobody intended.
 */
import { randomUUID } from 'node:crypto';
import { createRawPrismaClient, PrismaService, runWithTenant } from '@orbitoz/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  asRequestId,
  asTenantId,
  QUEUE_NAMES,
  tenantQueuePrefix,
  type BaseJob,
  type JobStatus,
} from '@orbitoz/shared-types';

import { ApprovalService } from '../../src/approvals/approval.service.js';
import {
  ApprovalExpiredError,
  ApprovalNotFoundError,
} from '../../src/approvals/approval.errors.js';
import { ApprovalSignatureService } from '../../src/approvals/approval-signature.service.js';
import { ApprovalTokenService } from '../../src/approvals/approval-token.service.js';
import { EnvService } from '../../src/config/env.service.js';
import { QueueProducer, APPROVAL_RESUME_QUEUE } from '../../src/queues/queue-producer.js';
import { TenantTransaction } from '../../src/tenancy/tenant-transaction.js';
import {
  applicationDatabaseUrl,
  disposableRedisUrl,
  loadRootEnv,
  ownerDatabaseUrl,
} from './environment.js';

export const FINGERPRINT = {
  ipAddress: '203.0.113.7',
  userAgent: 'approval-integration-test',
} as const;

export interface CreatedApproval {
  readonly tenantId: string;
  readonly userId: string;
  readonly token: string;
  readonly approvalId: string;
  readonly jobId: string;
}

/** One of the grants the view endpoint hands an approver. */
export interface SignedDecision {
  readonly action: 'APPROVE' | 'REJECT';
  readonly timestamp: string;
  readonly signature: string;
}

/**
 * What a test asks to post.
 *
 * The grant is optional so a test can post an action *without* one, or with a
 * timestamp borrowed from the other button — which is how the tampering cases are
 * built. A test that wants a real grant takes it from `grantFor`, so none of them
 * can invent a valid signature by hand.
 */
export interface DecisionRequest {
  readonly action: 'APPROVE' | 'REJECT';
  readonly timestamp?: string;
  readonly signature?: string;
}

export class ApprovalFixture {
  readonly env: EnvService;
  readonly prisma: PrismaService;
  readonly producer: QueueProducer;
  readonly signatures: ApprovalSignatureService;
  readonly service: ApprovalService;

  private readonly tokens = new ApprovalTokenService();
  private readonly transactions: TenantTransaction;
  private readonly redis: Redis;
  /**
   * The owner connection, used *only* by {@link createTenant} and {@link cleanup}.
   *
   * Kept separate from `prisma` so that "provision and tear down as an operator" is
   * visibly not the same capability as "act as a tenant". Every read and write under
   * test goes through the application role, where RLS is real.
   *
   * Built in the constructor rather than as a field initializer because the URL comes
   * from `.env`, which `loadRootEnv()` has not read yet when initializers run.
   */
  private readonly owner: ReturnType<typeof createRawPrismaClient>;
  private readonly tenants: string[] = [];

  private constructor() {
    loadRootEnv();
    disposableRedisUrl();

    this.env = new EnvService();
    this.prisma = new PrismaService({ connectionString: applicationDatabaseUrl() });
    this.transactions = new TenantTransaction(this.prisma);
    this.signatures = new ApprovalSignatureService({
      secret: this.env.value.approvals.signingSecret,
      toleranceSeconds: this.env.value.approvals.signatureToleranceSeconds,
    });
    this.producer = new QueueProducer(this.env);
    this.service = new ApprovalService(
      this.transactions,
      this.tokens,
      this.signatures,
      this.producer,
      this.env,
    );
    this.owner = createRawPrismaClient({ connectionString: ownerDatabaseUrl() });
    this.redis = new Redis(this.env.value.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      commandTimeout: this.env.value.redis.commandTimeoutMs,
    });
  }

  /**
   * Boots everything, including the RLS check.
   *
   * `PrismaService.onModuleInit()` refuses to start if the connection can see other
   * tenants' rows. Calling it here means a suite pointed at the owner role fails
   * immediately and loudly, instead of passing every assertion while testing
   * nothing — which is the failure mode that would make this suite worse than
   * useless.
   */
  static async start(): Promise<ApprovalFixture> {
    const fixture = new ApprovalFixture();
    await fixture.prisma.onModuleInit();
    return fixture;
  }

  /** A fresh tenant, tracked for cleanup. */
  async createTenant(label: string): Promise<string> {
    const id = randomUUID();
    // The owner connection, with no tenant GUC pinned: `rls_tenants_insert` allows
    // exactly this and nothing else, which is how signup provisions an account.
    await this.owner.tenant.create({
      data: {
        id,
        // Unique per run so an aborted previous run cannot collide on tenants_slug_key.
        slug: `approval-${label}-${id.slice(0, 8)}`.toLowerCase(),
        name: `Approval integration ${label}`,
      } as never,
    });
    this.tenants.push(id);
    return id;
  }

  /** Drives the real `ApprovalService.create`, so the rows under test are real rows. */
  async createApproval(tenantId: string, userId = randomUUID()): Promise<CreatedApproval> {
    const created = await this.service.create({
      tenantId,
      userId,
      requestId: asRequestId(randomUUID()),
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'summarise the incident report', name: null, toolCallId: null },
      ],
      // Every optional knob spelled out as null rather than omitted. The controller
      // fills these from the request body after validation, so omitting them here
      // would mean this suite exercised a different input shape than production does
      // — and a field that only the controller supplies is exactly the kind that
      // silently becomes required without anyone noticing.
      provider: null,
      strategy: null,
      temperature: null,
      maxTokens: null,
      topP: null,
      stopSequences: null,
      responseSchema: null,
      fanout: 1,
      idempotencyKey: null,
      maxCostUsd: null,
      conversationId: null,
      fingerprint: FINGERPRINT,
    });
    return {
      tenantId,
      userId,
      token: created.token,
      approvalId: created.approvalId,
      jobId: created.jobId,
    };
  }

  /**
   * Signs a decision the way an approver's browser would: by replaying the grant the
   * view endpoint hands out.
   *
   * Going through `getView` rather than calling `sign()` directly is deliberate. The
   * claim being tested is that a grant minted for APPROVE cannot decide a REJECT,
   * and the only way to hold the real browser's input is to use the real bytes it
   * would send.
   */
  async grantFor(approval: CreatedApproval): Promise<{
    approve: SignedDecision;
    reject: SignedDecision;
  }> {
    const view = await this.service.getView(approval.tenantId, approval.token);
    return {
      approve: {
        action: 'APPROVE',
        timestamp: view.actions.approve.timestamp,
        signature: view.actions.approve.signature,
      },
      reject: {
        action: 'REJECT',
        timestamp: view.actions.reject.timestamp,
        signature: view.actions.reject.signature,
      },
    };
  }

  /** Posts a decision through the real service. */
  decide(
    approval: CreatedApproval,
    request: DecisionRequest,
    overrides: {
      readonly timestamp?: string;
      readonly signature?: unknown;
      readonly note?: string | null;
    } = {},
  ) {
    return this.service.decide({
      tenantId: approval.tenantId,
      token: approval.token,
      action: request.action,
      timestamp:
        overrides.timestamp ?? request.timestamp ?? Math.floor(Date.now() / 1000).toString(),
      signature: overrides.signature ?? request.signature,
      note: overrides.note ?? null,
      fingerprint: FINGERPRINT,
      requestId: asRequestId(randomUUID()),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Reading state back, as the database and Redis actually hold it     */
  /* ------------------------------------------------------------------ */

  async approvalRow(tenantId: string, approvalId: string) {
    return runWithTenant({ tenantId, rlsPinned: true }, () =>
      this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', tenantId);
        return tx.approvalRequest.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id: approvalId } },
        });
      }),
    );
  }

  async jobRow(tenantId: string, jobId: string) {
    return runWithTenant({ tenantId, rlsPinned: true }, () =>
      this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', tenantId);
        return tx.inferenceJob.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id: jobId } },
        });
      }),
    );
  }

  async jobStatus(tenantId: string, jobId: string): Promise<JobStatus> {
    return (await this.jobRow(tenantId, jobId)).status;
  }

  /**
   * The jobs actually sitting on this tenant's queue, read through BullMQ.
   *
   * Opened with the production prefix, which is the point: if `QueueProducer` ever
   * derived a different one, this would return zero jobs and the resume would look
   * broken rather than merely mis-addressed.
   */
  async queuedJobs(
    tenantId: string,
  ): Promise<readonly { name: string; id: string; data: BaseJob }[]> {
    const queue = new Queue(APPROVAL_RESUME_QUEUE, {
      connection: this.redis,
      prefix: tenantQueuePrefix(asTenantId(tenantId)),
    });
    try {
      const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
      return jobs.map((job) => ({
        name: job.name,
        id: job.id ?? '',
        data: job.data as BaseJob,
      }));
    } finally {
      await queue.close();
    }
  }

  /**
   * Rewinds one field, as a crash between two transactions would.
   *
   * `ApprovalService` commits the decision, enqueues, then records the dispatch. A
   * crash after the enqueue leaves exactly this state: the row says not dispatched,
   * the queue holds the job. Re-deciding must then be a no-op, and the only thing
   * that can guarantee that is BullMQ's `jobId` deduplication.
   */
  async simulateCrashAfterEnqueue(tenantId: string, approvalId: string): Promise<void> {
    await runWithTenant({ tenantId, rlsPinned: true }, () =>
      this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', tenantId);
        await tx.approvalRequest.update({
          where: { tenantId_id: { tenantId, id: approvalId } },
          data: { dispatchedAt: null },
        });
      }),
    );
  }

  /** Backdates an approval so it is already past its `expires_at`. */
  async expire(tenantId: string, approvalId: string): Promise<void> {
    await runWithTenant({ tenantId, rlsPinned: true }, () =>
      this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', tenantId);
        await tx.approvalRequest.update({
          where: { tenantId_id: { tenantId, id: approvalId } },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
      }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Teardown                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Deletes exactly what this fixture created: its tenants' rows in Postgres, and
   * its tenants' Redis keys. Both matchers are built from the fixture's own tenant
   * ids, so neither can reach a key or a row belonging to anything else.
   */
  async cleanup(): Promise<void> {
    for (const tenantId of this.tenants) {
      await this.deleteQueueKeys(tenantId);
      // No delete policy exists on `tenants` for the app role, by design. The cascade
      // takes the jobs, approvals, audits and payload snapshots with it.
      await this.owner.tenant.deleteMany({ where: { id: tenantId } });
    }
    this.tenants.length = 0;

    await this.producer.onModuleDestroy();
    await this.prisma.onModuleDestroy();
    await this.owner.$disconnect();
    await this.redis.quit();
  }

  /** `UNLINK`s one tenant's queue keys. Never a wildcard. */
  private async deleteQueueKeys(tenantId: string): Promise<void> {
    const pattern = `orbitoz:{${tenantId}}:queue:*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await this.redis.unlink(...keys);
    } while (cursor !== '0');
  }
}

export { ApprovalExpiredError, ApprovalNotFoundError, QUEUE_NAMES };
