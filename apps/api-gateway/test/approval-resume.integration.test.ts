/**
 * The approval resume, end to end, against real Postgres and real Redis.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * `src/approvals/approval.service.test.ts` covers the decisions: which transaction
 * ran, in which order, whether an enqueue was even attempted. It stubs the queue, so
 * it cannot tell the difference between "BullMQ deduplicated this" and "we never
 * asked". Nor can it tell the difference between "RLS hid another tenant's row" and
 * "a `where` clause filtered it".
 *
 * Both of those are claims about Postgres and Redis, and this is where they are
 * checked. Everything below runs the production `ApprovalService` — no fake
 * database, no fake queue — so a regression in the real code fails here even when
 * every unit test still passes.
 *
 * ---------------------------------------------------------------------------
 * THE TWO INVARIANTS THE WHOLE MODULE RESTS ON
 * ---------------------------------------------------------------------------
 *   1. An approval resumes the job **exactly once**, no matter how many times the
 *      link is clicked, retried, or clicked concurrently from two devices. Enqueuing
 *      twice means a customer's inference job bills twice.
 *   2. An approval link for tenant A reveals and decides **nothing** for tenant B,
 *      even to a caller who holds A's token and a valid signature for it. Signature
 *      validity is per-token, so it cannot be what stops this; the tenant pinned to
 *      the transaction can.
 *
 * Each test below is one of those two, or the state that a fix for them would have
 * to preserve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRequestId, QUEUE_NAMES } from '@orbitoz/shared-types';
import { APPROVAL_RESUME_QUEUE } from '../src/queues/queue-producer.js';

import {
  ApprovalExpiredError,
  ApprovalFixture,
  ApprovalNotFoundError,
  FINGERPRINT,
  type CreatedApproval,
} from './support/approval-fixture.js';
import { ApprovalSignatureInvalidError } from '../src/approvals/approval.errors.js';

let fixture: ApprovalFixture;

/** A tenant and an approval parked on it, for tests that only need one. */
async function parked(label: string): Promise<CreatedApproval> {
  const tenantId = await fixture.createTenant(label);
  return fixture.createApproval(tenantId);
}

beforeAll(async () => {
  fixture = await ApprovalFixture.start();
});

afterAll(async () => {
  await fixture?.cleanup();
});

describe('creating an approval parks the job', () => {
  it('writes an AWAITING_APPROVAL job and a PENDING approval, and enqueues nothing', async () => {
    const approval = await parked('create');

    expect(await fixture.jobStatus(approval.tenantId, approval.jobId)).toBe('AWAITING_APPROVAL');

    const row = await fixture.approvalRow(approval.tenantId, approval.approvalId);
    expect(row.status).toBe('PENDING');
    expect(row.dispatchedAt).toBeNull();
    expect(row.dispatchAttempts).toBe(0);
    expect(row.jobId).toBe(approval.jobId);

    // The load-bearing assertion of this test: nothing may be on the queue yet. A
    // worker slot held for as long as a human takes to decide is the exact cost the
    // feature exists to avoid, and it would be invisible without reading Redis.
    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(0);
  });

  it('mints a link token that is never stored, only its hash', async () => {
    const approval = await parked('hash');

    expect(approval.token).toHaveLength(43);
    // A 43-character base64url token cannot fit a 64-character hash column, so this
    // also proves the column is holding a hash and not the token.
    const row = await fixture.approvalRow(approval.tenantId, approval.approvalId);
    expect(row.tokenHash).toHaveLength(64);
    expect(row.tokenHash).not.toContain(approval.token);
  });
});

describe('approving resumes the job exactly once', () => {
  it('enqueues a real BullMQ job on the tenant production prefix and settles the row', async () => {
    const approval = await parked('approve');
    const grants = await fixture.grantFor(approval);

    const result = await fixture.decide(approval, grants.approve);

    expect(result.outcome).toBe('recorded');
    expect(result.dispatched).toBe(true);
    expect(result.jobStatus).toBe('QUEUED');

    const [job] = await fixture.queuedJobs(approval.tenantId);
    expect(job).toBeDefined();
    // The prefix is the whole contract with the worker, and `queuedJobs` opens the
    // queue with `tenantQueuePrefix`, so finding the job here means the producer and
    // the consumer's subscription name the same keyspace.
    expect(job?.name).toBe('inference.route');
    // `jobId` is the dedup key, so it must be the job's own id and not a fresh uuid.
    expect(job?.id).toBe(approval.jobId);
    expect(job?.data.id).toBe(approval.jobId);
    expect(job?.data.tenantId).toBe(approval.tenantId);

    const row = await fixture.approvalRow(approval.tenantId, approval.approvalId);
    expect(row.status).toBe('APPROVED');
    expect(row.dispatchedAt).not.toBeNull();
    expect(row.dispatchAttempts).toBe(1);
    // The tenant's prompt is snapshotted, so a link approved next week still runs the
    // request that was actually made.
    expect(row.payload).toMatchObject({ model: 'gpt-4o-mini' });

    const jobRow = await fixture.jobRow(approval.tenantId, approval.jobId);
    expect(jobRow.status).toBe('QUEUED');
    expect(jobRow.queueJobId).toBe(approval.jobId);
    // The promotion is what the worker reads; without it the job would be resumed but
    // then refuse to start.
    expect(jobRow.startedAt).toBeNull();
  });

  it('treats a replayed click as already decided and enqueues nothing further', async () => {
    const approval = await parked('replay');
    const grants = await fixture.grantFor(approval);

    const first = await fixture.decide(approval, grants.approve);
    // Same bytes, sent again: a proxy retry, or an approver double-clicking.
    const second = await fixture.decide(approval, grants.approve);

    expect(first.dispatched).toBe(true);
    expect(second.outcome).toBe('already_decided');
    expect(second.dispatched).toBe(false);

    // The assertion that matters: one job, not two.
    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(1);
    expect(
      (await fixture.approvalRow(approval.tenantId, approval.approvalId)).dispatchAttempts,
    ).toBe(1);
  });

  it('gives two concurrent clicks one decision and one enqueue', async () => {
    const approval = await parked('concurrent');
    const grants = await fixture.grantFor(approval);

    // Two devices, one link. Started together so they contend for the claim.
    const [a, b] = await Promise.all([
      fixture.decide(approval, grants.approve),
      fixture.decide(approval, grants.approve),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['already_decided', 'recorded']);
    expect([a.dispatched, b.dispatched].filter(Boolean)).toHaveLength(1);

    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(1);
  });

  it('re-dispatches safely after a crash between the decision and the dispatch record', async () => {
    const approval = await parked('crash');
    const grants = await fixture.grantFor(approval);

    await fixture.decide(approval, grants.approve);
    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(1);

    // The exact state a process death in the enqueue window leaves: the decision is
    // durable, the queue holds the job, and `dispatched_at` was never written. This
    // is why `decide` re-runs the enqueue on a replay — and why that is safe.
    await fixture.simulateCrashAfterEnqueue(approval.tenantId, approval.approvalId);

    const retried = await fixture.decide(approval, grants.approve);

    // Deduplicated by `jobId`, not skipped: the row still needs its dispatch record,
    // so the enqueue has to be *attempted* and found to be a no-op.
    expect(retried.outcome).toBe('already_decided');
    expect(retried.dispatched).toBe(false);
    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(1);

    // Two attempts, not one — and that is the point of the column. It counts
    // *attempts*, so an operator reading a row that needed a retry can see it. What
    // must not double is the job, and it did not: the assertion above is the one
    // that would catch a second `add`.
    const row = await fixture.approvalRow(approval.tenantId, approval.approvalId);
    expect(row.dispatchAttempts).toBe(2);
    expect(row.dispatchedAt).not.toBeNull();
  });
});

describe('rejecting resumes nothing', () => {
  it('records the decision, cancels the job, and enqueues nothing', async () => {
    const approval = await parked('reject');
    const grants = await fixture.grantFor(approval);

    const result = await fixture.decide(approval, grants.reject, { note: 'not this quarter' });

    expect(result.outcome).toBe('recorded');
    expect(result.dispatched).toBe(false);
    // CANCELED, not left at AWAITING_APPROVAL. "Rejected" has to reach the job row
    // too: a job still marked as awaiting a decision would be picked up by a future
    // approval-shaped repair or sweep and re-run what a human just refused.
    expect(result.jobStatus).toBe('CANCELED');

    const row = await fixture.approvalRow(approval.tenantId, approval.approvalId);
    expect(row.status).toBe('REJECTED');
    expect(row.decisionNote).toBe('not this quarter');
    expect(row.dispatchedAt).toBeNull();

    const job = await fixture.jobRow(approval.tenantId, approval.jobId);
    expect(job.status).toBe('CANCELED');
    // `completed_at` is what makes the cancel terminal: the guard on the cancel is
    // "not already terminal", so without it a later approval could revive the row.
    expect(job.completedAt).not.toBeNull();

    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(0);
  });

  it('cannot be replayed into a resume', async () => {
    const approval = await parked('reject-replay');
    const grants = await fixture.grantFor(approval);

    await fixture.decide(approval, grants.reject);
    const replay = await fixture.decide(approval, grants.reject);

    expect(replay.outcome).toBe('already_decided');
    expect(replay.dispatched).toBe(false);
    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(0);
  });
});

describe('a signature for one action cannot decide the other', () => {
  it("refuses a rejection carrying the approve button's grant", async () => {
    const approval = await parked('cross-action');
    const grants = await fixture.grantFor(approval);

    // Both buttons are on the same rendered page, so both grants exist in the same
    // browser at the same time. Binding the signature to the action is the only thing
    // stopping an approver who meant to approve from having their click counted as a
    // rejection — and, in reverse, someone tampering the form to reject.
    //
    // Rejected as a *signature* failure, before any database work: verification runs
    // first so an unauthenticated caller cannot make the database do work before being
    // told no, and a rejected decision leaves the approval pending for a real approver.
    await expect(
      fixture.decide(
        approval,
        { action: 'REJECT' },
        { timestamp: grants.approve.timestamp, signature: grants.approve.signature },
      ),
    ).rejects.toBeInstanceOf(ApprovalSignatureInvalidError);

    expect((await fixture.approvalRow(approval.tenantId, approval.approvalId)).status).toBe(
      'PENDING',
    );
    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(0);
  });
});

describe('an expired link stays dead', () => {
  it('records the expiry, enqueues nothing, and keeps answering 410 on a retry', async () => {
    const approval = await parked('expired');
    const grants = await fixture.grantFor(approval);

    await fixture.expire(approval.tenantId, approval.approvalId);

    await expect(fixture.decide(approval, grants.approve)).rejects.toBeInstanceOf(
      ApprovalExpiredError,
    );

    const row = await fixture.approvalRow(approval.tenantId, approval.approvalId);
    // Recorded, not just rejected: the expiry is durable, so a later sweep would not
    // have to rediscover it.
    expect(row.status).toBe('EXPIRED');
    expect(await fixture.queuedJobs(approval.tenantId)).toHaveLength(0);

    // An approver who reloads and clicks again gets the same answer rather than a 200
    // that claims the link is finished, which is what would invite a retry loop
    // against a link that will never work.
    await expect(fixture.decide(approval, grants.approve)).rejects.toBeInstanceOf(
      ApprovalExpiredError,
    );
  });
});

describe('a token is scoped to its tenant by the database, not by the signature', () => {
  it('is not found from another tenant even though its signature is valid there', async () => {
    const approval = await parked('victim');
    const attackerTenantId = await fixture.createTenant('attacker');
    const grants = await fixture.grantFor(approval);

    // A perfectly valid grant for a real token. The caller's tenant is the only thing
    // that differs — and it is enough, because the lookup runs inside a transaction
    // pinned to the caller's tenant and RLS never returns another tenant's row.
    await expect(
      fixture.service.decide({
        tenantId: attackerTenantId,
        token: approval.token,
        action: 'APPROVE',
        timestamp: grants.approve.timestamp,
        signature: grants.approve.signature,
        note: null,
        fingerprint: FINGERPRINT,
        requestId: asRequestId('00000000-0000-4000-8000-000000000001'),
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);

    // Same for the read path, which is unauthenticated: possession of a token grants
    // nothing without the tenant, and the tenant is not in the URL.
    await expect(fixture.service.getView(attackerTenantId, approval.token)).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );

    expect((await fixture.approvalRow(approval.tenantId, approval.approvalId)).status).toBe(
      'PENDING',
    );
    expect(await fixture.queuedJobs(attackerTenantId)).toHaveLength(0);
  });
});

describe('the queue the resume uses', () => {
  it('is the shared ai-inference queue, not a bespoke one', () => {
    // A second queue name would mean a second worker subscription, a second set of
    // concurrency settings, and a queue nothing is listening on. Asserted because the
    // name is a string in a constant and nothing else would catch a rename — including
    // a rename on only one side, which is the case that actually loses a job.
    expect(APPROVAL_RESUME_QUEUE).toBe(QUEUE_NAMES.AiInference);
  });
});
