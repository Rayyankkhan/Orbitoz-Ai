/**
 * The approval state machine, with the database and the queue both faked.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOUBLE IS FAITHFUL INSTEAD OF A STUB
 * ---------------------------------------------------------------------------
 * The behaviour worth testing here is *ordering and gating*: one `updateMany`
 * predicate decides the single winner of a concurrent decision, the enqueue
 * happens outside every transaction, and a replay does not enqueue twice. Asserting
 * that needs a double that keeps rows and records operations. A `vi.fn()` returning
 * canned answers would let every test below pass against an implementation that
 * double-charges a tenant in production.
 *
 * So this fake keeps rows in arrays, implements the query shapes the service
 * actually issues (`{ gt }`, `{ notIn }`, `null`, compound `tenantId_id`), scopes
 * every read to the transaction's tenant the way the real Prisma extension does,
 * rolls back on throw, and tracks transaction depth so a test can assert that the
 * enqueue happened at depth zero.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * `vi.fn()` spies. This service calls `producer.enqueue` — an interaction
 * assertion would read better but would also be checking that a mock was called,
 * which the recorded queue contents already prove, and would break the moment the
 * implementation grew a legitimate second call.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT COVERED HERE
 * ---------------------------------------------------------------------------
 * That RLS really hides another tenant's token, and that a real BullMQ really
 * dedupes on `jobId`. Those are claims about Postgres and Redis, and a fake is the
 * wrong tool for either. They live in `db:verify` and in
 * `test/approval-resume.integration.test.ts`.
 */
import { Logger } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  INFERENCE_JOB,
  JobStatus,
  type AiProvider,
  type RoutingStrategy,
} from '@orbitoz/shared-types';
import { ApprovalService, type CreateApprovalInput } from './approval.service.js';
import { ApprovalSignatureService } from './approval-signature.service.js';
import { ApprovalTokenService, hashApprovalToken } from './approval-token.service.js';
import {
  ApprovalDispatchFailedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalSignatureExpiredError,
  ApprovalSignatureInvalidError,
} from './approval.errors.js';
import { APPROVAL_RESUME_QUEUE, type EnqueueOptions } from '../queues/queue-producer.js';
import type { TenantTransaction } from '../tenancy/tenant-transaction.js';
import type { QueueProducer } from '../queues/queue-producer.js';
import type { EnvService } from '../config/env.service.js';

/* -------------------------------------------------------------------------- */
/* In-memory database                                                           */
/* -------------------------------------------------------------------------- */

interface ApprovalRecord {
  tenantId: string;
  id: string;
  tokenHash: string;
  jobId: string;
  jobName: string;
  status: ApprovalStatus;
  payload: unknown;
  requestedByUserId: string;
  expiresAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  decisionIp: string | null;
  decisionUserAgent: string | null;
  decisionTraceId: string | null;
  dispatchedAt: Date | null;
  dispatchAttempts: number;
  createdAt: Date;
}

interface JobRecord {
  tenantId: string;
  id: string;
  status: JobStatus;
  queueJobId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface AuditRecord {
  action: string;
  actorId: string | null;
  metadata: Record<string, unknown>;
}

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/**
 * Flattens Prisma's compound-key form into a plain predicate.
 *
 * `{ tenantId_id: { tenantId, id } }` is one selector, not a field whose value is an
 * object, so a naive `Object.entries` comparison would never match anything.
 */
function normalizeWhere(where: Where): Where {
  const flat: Where = {};
  for (const [field, value] of Object.entries(where)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const keys = Object.keys(value);
      const looksCompound =
        keys.length > 0 &&
        keys.every((key) => !['gt', 'gte', 'lt', 'lte', 'notIn', 'in'].includes(key));
      if (looksCompound) {
        Object.assign(flat, value as Where);
        continue;
      }
    }
    flat[field] = value;
  }
  return flat;
}

function matchesField(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null;
  if (condition instanceof Date) return value instanceof Date && value > condition;
  if (Array.isArray(condition)) return condition.includes(value);
  if (typeof condition === 'object' && condition !== null) {
    const operators = condition as {
      gt?: Date;
      gte?: Date;
      notIn?: readonly unknown[];
      in?: readonly unknown[];
    };
    if (operators.gt !== undefined) return value instanceof Date && value > operators.gt;
    if (operators.gte !== undefined) return value instanceof Date && value >= operators.gte;
    if (operators.notIn !== undefined) return !operators.notIn.includes(value);
    if (operators.in !== undefined) return operators.in.includes(value);
    return false;
  }
  return value === condition;
}

function matches(row: Row, where: Where): boolean {
  const flat = normalizeWhere(where);
  return Object.entries(flat).every(([field, condition]) => matchesField(row[field], condition));
}

/** Applies `updateMany`'s `data`, honouring `{ increment }`. */
function applyUpdate(row: Row, data: Where): void {
  for (const [field, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in (value as Row)) {
      row[field] = ((row[field] as number | null) ?? 0) + ((value as Row).increment as number);
      continue;
    }
    row[field] = value;
  }
}

class FakeDatabase {
  readonly approvals: ApprovalRecord[] = [];
  readonly jobs: JobRecord[] = [];
  readonly audits: AuditRecord[] = [];
  /** Ordered record of every transaction boundary. */
  readonly events: string[] = [];

  /** Nesting depth right now. A correct implementation never exceeds one. */
  depth = 0;
  /** Transactions committed so far. Lets a test prove ordering, not just nesting. */
  commitCount = 0;

  /**
   * Mutates the approval row just before the next `updateMany` touches it.
   *
   * This is how a concurrent decision is modelled. A single-threaded double can never
   * lose a race by itself, so without a hook the `count === 0` branch — the one that
   * decides what a losing caller is told — would go untested, and it is exactly the
   * branch that has to re-read the row instead of reporting what the caller intended.
   */
  // Not private: `FakeHandle` — the object standing in for Prisma's delegates —
  // reads and clears this, and a `private` here would be a lie about who owns it.
  raceHook: ((approval: ApprovalRecord) => void) | null = null;

  /** Arms the row mutation above, to fire on the next approval `updateMany`. */
  armRace(mutate: (approval: ApprovalRecord) => void): void {
    this.raceHook = mutate;
  }

  private currentTenant: string | null = null;
  private snapshot: { approvals: ApprovalRecord[]; jobs: JobRecord[] } | null = null;
  private ids = 0;

  begin(tenantId: string): void {
    // A nested `run` would take a second pooled connection with no tenant GUC
    // pinned, so every read inside it would come back empty. Refusing it makes
    // that bug loud here instead of mysterious in staging.
    if (this.snapshot !== null) throw new Error('nested transaction');
    this.currentTenant = tenantId;
    this.snapshot = {
      approvals: this.approvals.map((row) => ({ ...row })),
      jobs: this.jobs.map((row) => ({ ...row })),
    };
    this.depth += 1;
    this.events.push(`begin:${tenantId.slice(0, 8)}`);
  }

  commit(): void {
    this.snapshot = null;
    this.currentTenant = null;
    this.depth -= 1;
    this.commitCount += 1;
    this.events.push('commit');
  }

  rollback(): void {
    if (this.snapshot === null) return;
    this.approvals.length = 0;
    this.approvals.push(...this.snapshot.approvals);
    this.jobs.length = 0;
    this.jobs.push(...this.snapshot.jobs);
    this.snapshot = null;
    this.currentTenant = null;
    this.depth -= 1;
    this.events.push('rollback');
  }

  /** Mirrors the RLS-scoped extension: a tenant-scoped read sees one tenant. */
  visible(row: Row): boolean {
    return this.currentTenant === null || row.tenantId === this.currentTenant;
  }

  /** Shared id sequence, so job and approval ids are unique across both tables. */
  nextId(): string {
    this.ids += 1;
    return `00000000-0000-4000-8000-${String(this.ids).padStart(12, '0')}`;
  }

  handle(): FakeHandle {
    return new FakeHandle(this);
  }
}

class FakeHandle {
  readonly inferenceJob: {
    create: (args: { data: Where }) => Promise<{ id: string }>;
    updateMany: (args: { where: Where; data: Where }) => Promise<{ count: number }>;
    findUnique: (args: { where: Where }) => Promise<{ status: JobStatus } | null>;
  };

  readonly approvalRequest: {
    create: (args: { data: Where }) => Promise<{ id: string }>;
    findUnique: (args: { where: Where }) => Promise<ApprovalRecord | null>;
    updateMany: (args: { where: Where; data: Where }) => Promise<{ count: number }>;
  };

  readonly auditLog: {
    create: (args: { data: Where }) => Promise<unknown>;
  };

  constructor(private readonly db: FakeDatabase) {
    this.inferenceJob = {
      create: ({ data }) => {
        const record: JobRecord = {
          tenantId: String(data.tenantId),
          id: this.db.nextId(),
          status: data.status as JobStatus,
          queueJobId: null,
          startedAt: null,
          completedAt: null,
        };
        this.db.jobs.push(record);
        return Promise.resolve({ id: record.id });
      },
      updateMany: ({ where, data }) => {
        let count = 0;
        for (const job of this.db.jobs) {
          const row = job as unknown as Row;
          if (!this.db.visible(row) || !matches(row, where)) continue;
          applyUpdate(row, data);
          count += 1;
        }
        return Promise.resolve({ count });
      },
      findUnique: ({ where }) => {
        const job = this.db.jobs.find((candidate) => {
          const row = candidate as unknown as Row;
          return this.db.visible(row) && matches(row, where);
        });
        return Promise.resolve(job === undefined ? null : { status: job.status });
      },
    };

    this.approvalRequest = {
      create: ({ data }) => {
        const record: ApprovalRecord = {
          tenantId: String(data.tenantId),
          id: this.db.nextId(),
          tokenHash: String(data.tokenHash),
          jobId: String(data.jobId),
          jobName: 'inference.route',
          status: ApprovalStatus.Pending,
          payload: data.payload,
          requestedByUserId: String(data.requestedByUserId),
          expiresAt: data.expiresAt as Date,
          decidedAt: null,
          decisionNote: null,
          decisionIp: null,
          decisionUserAgent: null,
          decisionTraceId: null,
          dispatchedAt: null,
          dispatchAttempts: 0,
          createdAt: new Date(),
        };
        this.db.approvals.push(record);
        return Promise.resolve({ id: record.id });
      },
      findUnique: ({ where }) => {
        const found = this.db.approvals.find((candidate) => {
          const row = candidate as unknown as Row;
          // Note the tenant filter applies even when the selector does not mention
          // one. `where: { tokenHash }` is how the service looks a token up, and it
          // is RLS — not a comparison in the service — that keeps it inside the
          // tenant. A fake that trusted the selector would let a cross-tenant read
          // pass, which is precisely the bug the test below exists to catch.
          return this.db.visible(row) && matches(row, where);
        });
        return Promise.resolve(found ?? null);
      },
      updateMany: ({ where, data }) => {
        if (this.db.raceHook !== null && this.db.approvals.length > 0) {
          const mutate = this.db.raceHook;
          this.db.raceHook = null;
          // Non-empty by the guard above, so the assertion states a fact rather
          // than papering over a possible empty read.
          mutate(this.db.approvals[0]!);
        }
        let count = 0;
        for (const approval of this.db.approvals) {
          const row = approval as unknown as Row;
          if (!this.db.visible(row) || !matches(row, where)) continue;
          applyUpdate(row, data);
          count += 1;
        }
        return Promise.resolve({ count });
      },
    };

    this.auditLog = {
      create: ({ data }) => {
        this.db.audits.push({
          action: String(data.action),
          actorId: (data.actorId as string | null) ?? null,
          metadata: (data.metadata as Record<string, unknown>) ?? {},
        });
        return Promise.resolve({ tenantId: data.tenantId });
      },
    };
  }
}

class FakeTransactions {
  constructor(private readonly db: FakeDatabase) {}

  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    this.db.begin(tenantId);
    try {
      const result = await fn();
      this.db.commit();
      return result;
    } catch (error) {
      this.db.rollback();
      throw error;
    }
  }

  get active(): FakeHandle {
    return this.db.handle();
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory queue                                                             */
/* -------------------------------------------------------------------------- */

interface EnqueueObservation {
  readonly options: EnqueueOptions;
  /** Transaction nesting depth at the moment of the call. Must be 0. */
  readonly depth: number;
  /** Transactions already committed. Must be at least 1. */
  readonly commitsBefore: number;
}

class FakeProducer {
  readonly enqueued: EnqueueOptions[] = [];
  readonly observations: EnqueueObservation[] = [];
  /** When set, `enqueue` throws it — used to model Redis being down. */
  failWith: Error | null = null;

  constructor(private readonly db: FakeDatabase) {}

  enqueue(options: EnqueueOptions): Promise<boolean> {
    // Recorded before the failure check, so a dispatch that threw still shows up as
    // an attempt against Redis.
    this.observations.push({
      options,
      depth: this.db.depth,
      commitsBefore: this.db.commitCount,
    });
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.enqueued.push(options);
    return Promise.resolve(true);
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

beforeAll(() => {
  // `ApprovalService` logs one line per dispatch, which is the right thing in
  // production and pure noise in a suite that dispatches dozens of times on purpose.
  // Assertions about behaviour are unaffected.
  Logger.overrideLogger(false);
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'approval-signing-secret-used-only-by-tests-0123456789';
const TTL_SECONDS = 86_400;
const TOLERANCE_SECONDS = 300;

const env = {
  value: {
    approvals: { requestTtlSeconds: TTL_SECONDS, signatureToleranceSeconds: TOLERANCE_SECONDS },
  },
} as unknown as EnvService;

interface Harness {
  readonly db: FakeDatabase;
  readonly producer: FakeProducer;
  readonly service: ApprovalService;
  readonly signatures: ApprovalSignatureService;
  readonly tokens: ApprovalTokenService;
  create(): Promise<Awaited<ReturnType<ApprovalService['create']>>>;
  decide(
    token: string,
    action: 'APPROVE' | 'REJECT',
    overrides?: {
      tenantId?: string;
      /** Presented instead of `token`, to model a wrong or unknown token. */
      presentedToken?: string;
      /** Signed `timestampSecondsAgo` seconds in the past. */
      timestampSecondsAgo?: number;
      note?: string;
    },
  ): Promise<Awaited<ReturnType<ApprovalService['decide']>>>;
}

function harness(): Harness {
  const db = new FakeDatabase();
  const producer = new FakeProducer(db);
  const signatures = new ApprovalSignatureService({
    secret: SECRET,
    toleranceSeconds: TOLERANCE_SECONDS,
  });
  const tokens = new ApprovalTokenService();

  const service = new ApprovalService(
    new FakeTransactions(db) as unknown as TenantTransaction,
    tokens,
    signatures,
    producer as unknown as QueueProducer,
    env,
  );

  const createInput = (): CreateApprovalInput => ({
    tenantId: TENANT,
    userId: USER,
    requestId: 'req-create-1',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'wire the money', name: null, toolCallId: null }],
    provider: null,
    strategy: null,
    temperature: null,
    maxTokens: null,
    topP: null,
    stopSequences: null,
    responseSchema: null,
    fanout: 1,
    idempotencyKey: null,
    maxCostUsd: 5,
    conversationId: null,
    fingerprint: { ipAddress: '10.0.0.1', userAgent: 'curl/8.0' },
  });

  return {
    db,
    producer,
    service,
    signatures,
    tokens,
    create: () => service.create(createInput()),
    decide: (token, action, overrides = {}) => {
      const presentedToken = overrides.presentedToken ?? token;
      const timestampSeconds = Math.floor(Date.now() / 1000) - (overrides.timestampSecondsAgo ?? 0);
      return service.decide({
        tenantId: overrides.tenantId ?? TENANT,
        token: presentedToken,
        action,
        timestamp: String(timestampSeconds),
        // Signed for whatever token is *presented*, so a test can model a grant that
        // is valid in form but aimed at the wrong capability.
        signature: signatures.sign(presentedToken, action, timestampSeconds),
        note: overrides.note ?? null,
        fingerprint: { ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0' },
        requestId: 'req-decide-1',
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.create', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('parks the job as AWAITING_APPROVAL and enqueues nothing', async () => {
    const { jobId } = await h.create();

    // The whole design rests on this: no queue entry exists while a human has not
    // decided. A genuinely paused BullMQ job would hold a concurrency slot for the
    // whole wait, which for a human-in-the-loop wait can be hours.
    expect(h.producer.enqueued).toEqual([]);
    expect(h.db.jobs).toHaveLength(1);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.AwaitingApproval);
    expect(h.db.jobs[0]?.id).toBe(jobId);
  });

  it('writes both rows inside exactly one transaction', async () => {
    await h.create();

    // A job with no approval row could never be resumed, and an approval row with no
    // job would approve nothing. One transaction is what makes neither reachable.
    expect(h.db.events).toEqual([`begin:${TENANT.slice(0, 8)}`, 'commit']);
    expect(h.db.approvals).toHaveLength(1);
  });

  it('snapshots the exact payload that will later be run', async () => {
    const { approvalId } = await h.create();

    const approval = h.db.approvals.find((row) => row.id === approvalId);
    expect(approval?.payload).toMatchObject({
      model: 'gpt-4o',
      maxCostUsd: 5,
      fanout: 1,
      messages: [{ role: 'user', content: 'wire the money' }],
    });
  });

  it('mints a 43-character token and stores only its hash', async () => {
    const { token } = await h.create();

    expect(token).toHaveLength(43);
    const approval = h.db.approvals[0];
    expect(approval?.tokenHash).toBe(hashApprovalToken(token));
    // A database dump, a read replica or a support query must not yield a working
    // link. This is the assertion that would catch someone "simplifying" the hash
    // away.
    expect(JSON.stringify(approval)).not.toContain(token);
  });

  it('returns relative paths, never an absolute URL', async () => {
    const created = await h.create();

    // Assembling one from the Host header would make this endpoint a redirect
    // primitive aimed wherever an attacker asked.
    expect(created.approvalPath).toBe(`/approvals/${created.token}`);
    expect(created.viewPath).toBe(`/approvals/${created.token}`);
    expect(created.approvalPath).not.toMatch(/^https?:/);
  });

  it('records APPROVAL_REQUESTED against the requesting user', async () => {
    await h.create();

    // The requesting user is a real principal and is recorded as the actor. The
    // approver, later, is not.
    expect(h.db.audits).toHaveLength(1);
    expect(h.db.audits[0]).toMatchObject({
      action: 'APPROVAL_REQUESTED',
      actorId: USER,
      metadata: { model: 'gpt-4o' },
    });
  });

  it('expires the link after the configured TTL', async () => {
    const before = Date.now();
    const created = await h.create();

    const expiresAt = h.db.approvals[0]?.expiresAt.getTime() ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + TTL_SECONDS * 1_000 - 1_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + TTL_SECONDS * 1_000);
    expect(created.status).toBe(ApprovalStatus.Pending);
  });

  it('freezes a null strategy into the snapshot so the job is deterministic', async () => {
    await h.create();

    const payload = h.db.approvals[0]?.payload as { strategy: RoutingStrategy };
    // The snapshot has to be runnable on its own: the worker resolves defaults at
    // run time, and "whatever the tenant default was when the page was rendered" is
    // not a value.
    expect(payload.strategy).toBe('BALANCED');
  });
});

/* -------------------------------------------------------------------------- */
/* View                                                                        */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.getView', () => {
  let h: Harness;
  let token: string;

  beforeEach(async () => {
    h = harness();
    ({ token } = await h.create());
  });

  it('pre-signs both actions, so the page needs no client-side secret', async () => {
    const view = await h.service.getView(TENANT, token);

    // The approver's browser cannot compute an HMAC, so the server hands it a
    // pre-signed pair and the click posts it back verbatim.
    expect(view.actions.approve.action).toBe('APPROVE');
    expect(view.actions.reject.action).toBe('REJECT');
    expect(view.actions.approve.signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(view.actions.reject.signature).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('signs the two actions differently', async () => {
    const view = await h.service.getView(TENANT, token);

    expect(view.actions.approve.signature).not.toBe(view.actions.reject.signature);
    // One page load, one timestamp: they were rendered together.
    expect(view.actions.approve.timestamp).toBe(view.actions.reject.timestamp);
  });

  it('hands out grants that verify', async () => {
    const view = await h.service.getView(TENANT, token);

    // Otherwise the link would render fine and fail on every click.
    expect(
      h.signatures.verify(
        token,
        'APPROVE',
        view.actions.approve.timestamp,
        view.actions.approve.signature,
      ),
    ).toEqual({ ok: true });
    expect(
      h.signatures.verify(
        token,
        'REJECT',
        view.actions.reject.timestamp,
        view.actions.reject.signature,
      ),
    ).toEqual({ ok: true });
  });

  it('shows what the approver is actually deciding on', async () => {
    const view = await h.service.getView(TENANT, token);

    expect(view.approval).toMatchObject({
      model: 'gpt-4o',
      maxCostUsd: 5,
      status: ApprovalStatus.Pending,
      dispatched: false,
      requestedBy: USER,
      decidedAt: null,
    });
  });

  it('reports a decided request rather than hiding it', async () => {
    await h.decide(token, 'APPROVE');
    const view = await h.service.getView(TENANT, token);

    // An approver who opens a link someone already spent should see that, which is
    // information. A 404 would read as a broken link.
    expect(view.approval.status).toBe(ApprovalStatus.Approved);
    expect(view.approval.dispatched).toBe(true);
    expect(view.approval.decidedAt).not.toBeNull();
  });

  it('is invisible to another tenant', async () => {
    await expect(h.service.getView(OTHER_TENANT, token)).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
  });

  it('is indistinguishable from an unknown token on another tenant', async () => {
    const unknown = await h.service
      .getView(OTHER_TENANT, h.tokens.issue().token)
      .catch((error: unknown) => error);
    const wrongTenant = await h.service
      .getView(OTHER_TENANT, token)
      .catch((error: unknown) => error);

    // Otherwise this public endpoint becomes an oracle for probing which tenant a
    // given token belongs to.
    expect((unknown as { code: string }).code).toBe((wrongTenant as { code: string }).code);
    expect((unknown as Error).message).toBe((wrongTenant as Error).message);
  });
});

/* -------------------------------------------------------------------------- */
/* Decide — approving                                                          */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.decide — approving', () => {
  let h: Harness;
  let token: string;
  let jobId: string;

  beforeEach(async () => {
    h = harness();
    ({ token } = await h.create());
    jobId = h.db.jobs[0]?.id ?? '';
  });

  it('enqueues the job and promotes it to QUEUED', async () => {
    const result = await h.decide(token, 'APPROVE');

    expect(result.outcome).toBe('recorded');
    expect(result.dispatched).toBe(true);
    expect(result.jobStatus).toBe(JobStatus.Queued);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.Queued);
    expect(h.producer.enqueued).toHaveLength(1);
  });

  it('uses the database job id as the BullMQ job id', async () => {
    await h.decide(token, 'APPROVE');

    // The worker's processor reads `job.data.id` as the row to run, so the two
    // cannot differ. Making them the same value is also what makes the enqueue
    // self-deduplicating, with no second identifier to keep in sync.
    const enqueued = h.producer.enqueued[0];
    expect(enqueued?.jobId).toBe(jobId);
    expect(enqueued?.envelope.id).toBe(jobId);
    expect(h.db.jobs[0]?.queueJobId).toBe(jobId);
  });

  it('enqueues onto the ai-inference queue under the route job name', async () => {
    await h.decide(token, 'APPROVE');

    const enqueued = h.producer.enqueued[0];
    expect(enqueued?.queue).toBe(APPROVAL_RESUME_QUEUE);
    expect(enqueued?.queue).toBe('ai-inference');
    expect(enqueued?.jobName).toBe(INFERENCE_JOB.Route);
  });

  it('carries the requesting user, not the approver', async () => {
    await h.decide(token, 'APPROVE');

    const envelope = h.producer.enqueued[0]?.envelope;
    // The click has no principal: that route is public. The job belongs to whoever
    // asked for it, and `envelope.userId` is the worker's ambient scope.
    expect(envelope?.userId).toBe(USER);
    expect(envelope?.tenantId).toBe(TENANT);
  });

  it('traces the resumed job back to the decision request', async () => {
    await h.decide(token, 'APPROVE');

    // The provider call lands in a table keyed by trace id. Without this the cost
    // of an approved job is unattributable.
    expect(h.producer.enqueued[0]?.envelope.traceId).toBe('req-decide-1');
  });

  it('enqueues the snapshot, not anything the caller supplied', async () => {
    await h.decide(token, 'APPROVE');

    const payload = h.producer.enqueued[0]?.envelope.payload as {
      model: string;
      maxCostUsd: number;
      options: {
        temperature: number | null;
        maxTokens: number | null;
        topP: number | null;
        stopSequences: readonly string[] | null;
        responseSchema: Record<string, unknown> | null;
      };
      provider: AiProvider | null;
    };

    expect(payload.model).toBe('gpt-4o');
    expect(payload.maxCostUsd).toBe(5);
    // Explicit nulls, not omissions: a payload restored from JSON months later must
    // have the same shape as a fresh one.
    expect(payload.provider).toBeNull();
    expect(payload.options.temperature).toBeNull();
    expect(payload.options.maxTokens).toBeNull();
    expect(payload.options.topP).toBeNull();
    expect(payload.options.stopSequences).toBeNull();
    expect(payload.options.responseSchema).toBeNull();
  });

  it('enqueues at transaction depth zero, after the decision has committed', async () => {
    await h.decide(token, 'APPROVE');

    // The load-bearing ordering claim of the whole module. Enqueueing inside the
    // transaction that records the decision would let a worker start calling a
    // provider before the approval was durable; a rollback would then leave a job
    // that ran, and billed, against a row saying it was never approved. And
    // committing only after the enqueue would strand the resume on a crash.
    const [observation] = h.producer.observations;
    expect(observation?.depth).toBe(0);
    expect(observation?.commitsBefore).toBeGreaterThanOrEqual(1);
  });

  it('takes exactly two transactions around the enqueue', async () => {
    const eventsAfterCreate = h.db.events.length;
    await h.decide(token, 'APPROVE');

    // One to record the decision, one to record that the resume landed. Nothing else
    // is written, and nothing is written inside the enqueue.
    expect(h.db.events.slice(eventsAfterCreate)).toEqual([
      `begin:${TENANT.slice(0, 8)}`,
      'commit',
      `begin:${TENANT.slice(0, 8)}`,
      'commit',
    ]);
  });

  it('records the decision metadata', async () => {
    await h.decide(token, 'APPROVE', { note: 'checked the amount' });

    const approval = h.db.approvals[0];
    expect(approval?.status).toBe(ApprovalStatus.Approved);
    expect(approval?.decidedAt).toBeInstanceOf(Date);
    expect(approval?.decisionIp).toBe('203.0.113.9');
    expect(approval?.decisionUserAgent).toBe('Mozilla/5.0');
    expect(approval?.decisionTraceId).toBe('req-decide-1');
    expect(approval?.decisionNote).toBe('checked the amount');
    expect(approval?.dispatchedAt).toBeInstanceOf(Date);
    expect(approval?.dispatchAttempts).toBe(1);
  });

  it('audits the approval with no actor, because the route has no principal', async () => {
    await h.decide(token, 'APPROVE');

    expect(h.db.audits.at(-1)).toMatchObject({
      action: 'APPROVAL_APPROVED',
      actorId: null,
      metadata: { jobId },
    });
  });

  it('never writes the token into an audit row', async () => {
    await h.decide(token, 'APPROVE');

    // The IP and user agent are what identify the approver. Logging the token would
    // turn the audit log into a credential store.
    expect(JSON.stringify(h.db.audits)).not.toContain(token);
  });

  it('reports the snapshot in the response', async () => {
    const result = await h.decide(token, 'APPROVE');

    expect(result.approval).toMatchObject({ model: 'gpt-4o', maxCostUsd: 5, dispatched: true });
    expect(result.requestId).toBe('req-decide-1');
  });
});

/* -------------------------------------------------------------------------- */
/* Decide — rejecting                                                          */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.decide — rejecting', () => {
  let h: Harness;
  let token: string;

  beforeEach(async () => {
    h = harness();
    ({ token } = await h.create());
  });

  it('cancels the job and never enqueues', async () => {
    const result = await h.decide(token, 'REJECT');

    expect(result.outcome).toBe('recorded');
    expect(result.jobStatus).toBe(JobStatus.Canceled);
    expect(result.dispatched).toBe(false);
    expect(h.producer.enqueued).toEqual([]);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.Canceled);
  });

  it('stamps completedAt, so the cancellation is a finished job', async () => {
    await h.decide(token, 'REJECT');

    // A CANCELED row with no completedAt looks identical to one that stalled, and
    // the two want opposite follow-ups.
    expect(h.db.jobs[0]?.completedAt).toBeInstanceOf(Date);
  });

  it('audits the rejection with no actor', async () => {
    await h.decide(token, 'REJECT');

    expect(h.db.audits.at(-1)).toMatchObject({ action: 'APPROVAL_REJECTED', actorId: null });
  });

  it('leaves dispatchedAt null, because nothing was dispatched', async () => {
    await h.decide(token, 'REJECT');

    expect(h.db.approvals[0]?.dispatchedAt).toBeNull();
    expect(h.db.approvals[0]?.dispatchAttempts).toBe(0);
  });

  it('records the decision and reads back the job status, in two transactions', async () => {
    const eventsAfterCreate = h.db.events.length;
    await h.decide(token, 'REJECT');

    // One to record the rejection and cancel the job, one to report the status the
    // cancellation produced. There is no third: nothing was enqueued, so there is no
    // dispatch to settle.
    expect(h.db.events.slice(eventsAfterCreate)).toEqual([
      `begin:${TENANT.slice(0, 8)}`,
      'commit',
      `begin:${TENANT.slice(0, 8)}`,
      'commit',
    ]);
  });

  it('does not overwrite a job that had already finished', async () => {
    // The approver was too late. Overwriting a completed run would be worse than the
    // race: the result is real and the cost is already incurred.
    const job = h.db.jobs[0];
    if (job) job.status = JobStatus.Succeeded;

    await h.decide(token, 'REJECT');

    expect(h.db.jobs[0]?.status).toBe(JobStatus.Succeeded);
    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Rejected);
  });
});

/* -------------------------------------------------------------------------- */
/* Decide — idempotency                                                        */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.decide — idempotency', () => {
  let h: Harness;
  let token: string;

  beforeEach(async () => {
    h = harness();
    ({ token } = await h.create());
  });

  it('does not enqueue twice when the same decision is replayed', async () => {
    await h.decide(token, 'APPROVE');
    const replay = await h.decide(token, 'APPROVE');

    expect(replay.outcome).toBe('already_decided');
    expect(replay.dispatched).toBe(false);
    expect(h.producer.enqueued).toHaveLength(1);
  });

  it('answers a replay as a success rather than a conflict', async () => {
    await h.decide(token, 'APPROVE');

    // A webhook sender that retries after losing a response must not be handed a 409
    // for something it already did successfully.
    await expect(h.decide(token, 'APPROVE')).resolves.toMatchObject({
      outcome: 'already_decided',
      jobStatus: JobStatus.Queued,
    });
  });

  it('enqueues exactly once across a whole replay sequence', async () => {
    await h.decide(token, 'APPROVE');
    await h.decide(token, 'APPROVE');
    await h.decide(token, 'APPROVE');

    expect(h.producer.enqueued).toHaveLength(1);
    expect(h.db.audits.filter((row) => row.action === 'APPROVAL_APPROVED')).toHaveLength(1);
  });

  it('refuses a rejection after an approval and does not cancel the running job', async () => {
    await h.decide(token, 'APPROVE');
    await h.decide(token, 'REJECT');

    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Approved);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.Queued);
    expect(h.producer.enqueued).toHaveLength(1);
  });

  it('refuses an approval after a rejection', async () => {
    await h.decide(token, 'REJECT');
    await h.decide(token, 'APPROVE');

    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Rejected);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.Canceled);
    expect(h.producer.enqueued).toEqual([]);
  });

  it('resumes the job when an earlier attempt committed the decision but never enqueued', async () => {
    await h.decide(token, 'APPROVE');

    // Model the crash window by rewinding only `dispatchedAt`, which is exactly the
    // field that exists to make it recoverable. A lost response to a successful
    // approval must not become a job that never runs.
    const approval = h.db.approvals[0];
    if (approval) approval.dispatchedAt = null;
    h.producer.enqueued.length = 0;

    const retried = await h.decide(token, 'APPROVE');

    expect(retried.dispatched).toBe(true);
    expect(retried.outcome).toBe('recorded');
    expect(h.producer.enqueued).toHaveLength(1);
    expect(h.db.approvals[0]?.dispatchedAt).toBeInstanceOf(Date);
  });

  it('counts each attempt to reach the queue', async () => {
    await h.decide(token, 'APPROVE');
    const approval = h.db.approvals[0];
    if (approval) approval.dispatchedAt = null;
    await h.decide(token, 'APPROVE');

    // Otherwise a request that keeps failing to resume shows up as an approval that
    // silently did nothing, with nothing to query for.
    expect(h.db.approvals[0]?.dispatchAttempts).toBe(2);
  });

  it('does not re-queue a job that reached a terminal state', async () => {
    await h.decide(token, 'APPROVE');
    const job = h.db.jobs[0];
    if (job) job.status = JobStatus.Succeeded;
    const approval = h.db.approvals[0];
    if (approval) approval.dispatchedAt = null;

    await h.decide(token, 'APPROVE');

    // The promotion is refused, so the reported status is the real one. Re-queueing
    // a finished job would re-bill the tenant.
    expect(h.db.jobs[0]?.status).toBe(JobStatus.Succeeded);
  });

  it('reports the promotion refusal honestly in jobStatus', async () => {
    await h.decide(token, 'APPROVE');
    const job = h.db.jobs[0];
    if (job) job.status = JobStatus.Failed;
    const approval = h.db.approvals[0];
    if (approval) approval.dispatchedAt = null;

    const retried = await h.decide(token, 'APPROVE');

    // Not a hardcoded QUEUED: the response has to describe what is actually stored.
    expect(retried.jobStatus).toBe(JobStatus.Failed);
  });

  it('lets a concurrent winner stand, and reports its outcome rather than this one', async () => {
    // Models the loser of a race: another transaction read PENDING, decided, and
    // dispatched between this one's read and its own `updateMany`.
    h.db.armRace((approval) => {
      approval.status = ApprovalStatus.Approved;
      approval.dispatchedAt = new Date();
    });

    const result = await h.decide(token, 'APPROVE');

    // The loser's `updateMany` matched zero rows, so the branch that matters runs:
    // re-read the row and answer with what happened, not with what was attempted. A
    // service that returned `recorded` here would have two callers claiming to have
    // approved, and an approver-facing audit trail that says so.
    expect(result.outcome).toBe('already_decided');
    expect(result.dispatched).toBe(false);
    expect(h.producer.enqueued).toEqual([]);
  });

  it('writes one decision audit row for a raced decision', async () => {
    h.db.armRace((approval) => {
      approval.status = ApprovalStatus.Approved;
      approval.dispatchedAt = new Date();
    });

    await h.decide(token, 'APPROVE');

    // The audit write sits behind the same claim, so the loser adds nothing.
    expect(h.db.audits.filter((row) => row.action === 'APPROVAL_APPROVED')).toHaveLength(0);
    expect(h.db.audits.filter((row) => row.action === 'APPROVAL_REQUESTED')).toHaveLength(1);
  });

  it("does not overwrite the winner's decision metadata", async () => {
    h.db.armRace((approval) => {
      approval.status = ApprovalStatus.Approved;
      approval.decidedAt = new Date('2026-01-01T00:00:00.000Z');
      approval.decisionIp = '198.51.100.4';
      approval.dispatchedAt = new Date();
    });

    await h.decide(token, 'APPROVE', { note: 'my note' });

    const approval = h.db.approvals[0];
    expect(approval?.decisionIp).toBe('198.51.100.4');
    expect(approval?.decisionNote).toBeNull();
  });

  it('leaves the decision final even when the job promotion did not apply', async () => {
    await h.decide(token, 'APPROVE');
    const approval = h.db.approvals[0];
    if (approval) approval.dispatchedAt = null;
    await h.decide(token, 'APPROVE');

    // `dispatchedAt` and the job status are written in the same transaction, so a
    // second pass over both cannot end up claiming a resume that never landed.
    expect(approval?.status).toBe(ApprovalStatus.Approved);
    expect(approval?.dispatchedAt).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Decide — expiry                                                             */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.decide — expiry', () => {
  /** Puts the deadline in the past, which is what click-time expiry keys off. */
  function expire(h: Harness): void {
    const approval = h.db.approvals[0];
    if (approval) approval.expiresAt = new Date(Date.now() - 1_000);
  }

  it('marks the request EXPIRED, cancels the job, and refuses', async () => {
    const h = harness();
    const { token } = await h.create();
    expire(h);

    await expect(h.decide(token, 'APPROVE')).rejects.toBeInstanceOf(ApprovalExpiredError);

    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Expired);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.Canceled);
    expect(h.producer.enqueued).toEqual([]);
    expect(h.db.audits.at(-1)?.action).toBe('APPROVAL_EXPIRED');
  });

  it('reports expiry as 410, distinct from an invalid link', async () => {
    const h = harness();
    const { token } = await h.create();
    expire(h);

    // The token *was* valid. Telling the approver their link went stale is the
    // difference between them asking for a new one and them believing it is broken.
    await expect(h.decide(token, 'APPROVE')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
  });

  it('commits the expiry instead of rolling it back', async () => {
    const h = harness();
    const { token } = await h.create();
    expire(h);

    await h.decide(token, 'APPROVE').catch(() => undefined);

    // `create`'s transaction, then the expiry's. No rollback anywhere: an exception
    // raised *inside* `transactions.run` would undo the status write and leave a dead
    // link looking live until somebody inspected the deadline column.
    expect(h.db.events).toEqual([
      `begin:${TENANT.slice(0, 8)}`,
      'commit',
      `begin:${TENANT.slice(0, 8)}`,
      'commit',
    ]);
    expect(h.db.events).not.toContain('rollback');
    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Expired);
  });

  it('keeps saying expired on a second attempt, without re-auditing', async () => {
    const h = harness();
    const { token } = await h.create();
    expire(h);

    // Both attempts get the same 410. Returning 200-with-EXPIRED the second time
    // would leave a retrying client unable to tell a finished decision from a live
    // one, and would invite it to keep retrying a link that will never work.
    await expect(h.decide(token, 'APPROVE')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await expect(h.decide(token, 'APPROVE')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });

    // The expiry is recorded once, not re-announced on every click.
    expect(h.db.audits.filter((row) => row.action === 'APPROVAL_EXPIRED')).toHaveLength(1);
    expect(h.producer.enqueued).toEqual([]);
  });

  it('accepts a decision on a link whose deadline has not passed', async () => {
    const h = harness();
    const { token } = await h.create();

    await expect(h.decide(token, 'APPROVE')).resolves.toMatchObject({ outcome: 'recorded' });
  });
});

/* -------------------------------------------------------------------------- */
/* Decide — verification order and tenant scope                                */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.decide — verification', () => {
  let h: Harness;
  let token: string;

  beforeEach(async () => {
    h = harness();
    ({ token } = await h.create());
  });

  it('rejects a forged signature before opening a transaction', async () => {
    const eventsBefore = h.db.events.length;

    await expect(
      h.service.decide({
        tenantId: TENANT,
        token,
        action: 'APPROVE',
        timestamp: String(Math.floor(Date.now() / 1000)),
        signature: `v1=${'0'.repeat(64)}`,
        note: null,
        fingerprint: { ipAddress: null, userAgent: null },
        requestId: 'req-forged',
      }),
    ).rejects.toBeInstanceOf(ApprovalSignatureInvalidError);

    // An unauthenticated caller must not be able to make a public endpoint do
    // database work before it has proved anything.
    expect(h.db.events.length).toBe(eventsBefore);
    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Pending);
  });

  it('reports a stale grant distinctly, because reloading the page fixes it', async () => {
    await expect(
      h.decide(token, 'APPROVE', { timestampSecondsAgo: TOLERANCE_SECONDS + 100 }),
    ).rejects.toBeInstanceOf(ApprovalSignatureExpiredError);

    // Every other verification failure is one opaque 401. A stale grant is the one
    // case with an action the caller can take, so it earns its own code.
  });

  it('accepts a grant at the edge of the tolerance', async () => {
    // Off-by-one on a boundary is exactly how "this link randomly stopped working"
    // reports itself.
    await expect(
      h.decide(token, 'APPROVE', { timestampSecondsAgo: TOLERANCE_SECONDS }),
    ).resolves.toMatchObject({ outcome: 'recorded' });
  });

  it('refuses a grant signed for the other action', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      h.service.decide({
        tenantId: TENANT,
        token,
        // Signed as APPROVE, presented as REJECT: the attack the action field in the
        // MAC exists to stop.
        action: 'REJECT',
        timestamp: String(now),
        signature: h.signatures.sign(token, 'APPROVE', now),
        note: null,
        fingerprint: { ipAddress: null, userAgent: null },
        requestId: 'req-swapped',
      }),
    ).rejects.toBeInstanceOf(ApprovalSignatureInvalidError);
    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Pending);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.AwaitingApproval);
  });

  it('refuses a valid grant presented on another tenant', async () => {
    await expect(h.decide(token, 'APPROVE', { tenantId: OTHER_TENANT })).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );

    // RLS makes the row invisible, so this is indistinguishable from an unknown
    // token. There is deliberately no cross-tenant branch in the service.
    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Pending);
    expect(h.producer.enqueued).toEqual([]);
  });

  it('refuses an unknown token', async () => {
    await expect(
      h.decide(token, 'APPROVE', { presentedToken: h.tokens.issue().token }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it('gives an unknown token and a wrong-tenant token the identical error', async () => {
    const unknown = await h
      .decide(token, 'APPROVE', { presentedToken: h.tokens.issue().token })
      .catch((error: unknown) => error);
    const wrongTenant = await h
      .decide(token, 'APPROVE', { tenantId: OTHER_TENANT })
      .catch((error: unknown) => error);

    expect((unknown as { code: string }).code).toBe('APPROVAL_NOT_FOUND');
    expect((unknown as { code: string }).code).toBe((wrongTenant as { code: string }).code);
    expect((unknown as Error).message).toBe((wrongTenant as Error).message);
  });

  it('does not let a second tenant write to the approval through a scoped update', async () => {
    // Even with the read hidden, the write is scoped by `tenantId` in the selector.
    // Belt and braces, and the fake enforces both because the real thing does.
    await expect(h.decide(token, 'APPROVE', { tenantId: OTHER_TENANT })).rejects.toBeDefined();
    expect(h.db.approvals.filter((row) => row.status === ApprovalStatus.Approved)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Decide — dispatch failure                                                   */
/* -------------------------------------------------------------------------- */

describe('ApprovalService.decide — dispatch failure', () => {
  it('reports a 503 and leaves the resume outstanding', async () => {
    const h = harness();
    const { token } = await h.create();
    h.producer.failWith = new Error('ECONNREFUSED 127.0.0.1:6379');

    await expect(h.decide(token, 'APPROVE')).rejects.toBeInstanceOf(ApprovalDispatchFailedError);

    // The decision is durable and the job is still parked. That combination is what
    // makes a retry able to complete the work instead of losing it.
    expect(h.db.approvals[0]?.status).toBe(ApprovalStatus.Approved);
    expect(h.db.approvals[0]?.dispatchedAt).toBeNull();
    expect(h.db.jobs[0]?.status).toBe(JobStatus.AwaitingApproval);
  });

  it('uses a service-unavailable code, not a client-error code', async () => {
    const h = harness();
    const { token } = await h.create();
    h.producer.failWith = new Error('down');

    // Reporting this as a 4xx would tell a webhook sender its request was malformed
    // when the queue is simply unreachable.
    await expect(h.decide(token, 'APPROVE')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('does not run the second transaction, so the state stays coherent', async () => {
    const h = harness();
    const { token } = await h.create();
    const eventsAfterCreate = h.db.events.length;
    h.producer.failWith = new Error('down');

    await h.decide(token, 'APPROVE').catch(() => undefined);

    // The promotion is written only after the queue accepted the job, so a reader can
    // never see QUEUED for a job nobody will run. With Redis down, only the decision
    // transaction ran.
    expect(h.db.events.slice(eventsAfterCreate)).toEqual([`begin:${TENANT.slice(0, 8)}`, 'commit']);
    expect(h.db.jobs[0]?.status).toBe(JobStatus.AwaitingApproval);
  });

  it('completes the resume on retry once the queue is back', async () => {
    const h = harness();
    const { token } = await h.create();
    h.producer.failWith = new Error('down');
    await h.decide(token, 'APPROVE').catch(() => undefined);

    h.producer.failWith = null;
    await expect(h.decide(token, 'APPROVE')).resolves.toMatchObject({ dispatched: true });

    expect(h.db.jobs[0]?.status).toBe(JobStatus.Queued);
    expect(h.db.approvals[0]?.dispatchedAt).toBeInstanceOf(Date);
  });

  it('does not record a second approval audit on the retry', async () => {
    const h = harness();
    const { token } = await h.create();
    h.producer.failWith = new Error('down');
    await h.decide(token, 'APPROVE').catch(() => undefined);
    h.producer.failWith = null;
    await h.decide(token, 'APPROVE');

    // The decision happened once. The retry resumed it; it did not decide again.
    expect(h.db.audits.filter((row) => row.action === 'APPROVAL_APPROVED')).toHaveLength(1);
  });
});
