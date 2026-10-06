/**
 * The Prisma inference store's mapping logic.
 *
 * No Postgres here: a fake `withTenant` hands the store a transaction of spies, so
 * what is asserted is the *translation* — a catalogue row plus its tenant override
 * becomes a `RoutableModel` with the right reliability, a success writes the cost
 * it actually incurred, and a non-terminal failure is not allowed to close the
 * job. The SQL itself is Prisma's to prove; the decisions above it are ours.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentAttempt } from '@orbitoz/ai-engine';
import { PLAN_ENTITLEMENTS, SubscriptionPlan } from '@orbitoz/shared-types';
import type { WorkerDatabase } from '../worker/worker-database.js';
import {
  asAiProvider,
  PrismaInferenceStore,
  type FailureOutcome,
  type SuccessOutcome,
} from './inference-store.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_UUID = '33333333-3333-4333-8333-333333333333';

function modelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MODEL_UUID,
    provider: 'OPENAI',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    capabilities: ['CHAT', 'STRUCTURED_OUTPUT'],
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    inputCostPerMTokens: 2_000_000,
    outputCostPerMTokens: 4_000_000,
    qualityScore: 9_000,
    latencyScore: 8_000,
    isDeprecated: false,
    isEnabled: true,
    ...overrides,
  };
}

type Tx = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

function fakeTx(overrides: Partial<Tx> = {}): Tx {
  const tx: Tx = {
    tenant: { findUnique: vi.fn(async () => ({ plan: 'ENTERPRISE' })) },
    providerModel: { findMany: vi.fn(async () => [modelRow()]) },
    tenantProvider: { findMany: vi.fn(async () => []) },
    providerAttempt: {
      groupBy: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    usageRecord: { create: vi.fn(async () => ({})) },
    inferenceJob: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { ...tx, ...overrides };
}

function storeFor(tx: Tx): PrismaInferenceStore {
  const db = {
    withTenant: async (_tenantId: string, fn: (handle: Tx) => Promise<unknown>) => fn(tx),
  } as unknown as WorkerDatabase;
  return new PrismaInferenceStore(db);
}

function successOutcome(attempts: readonly AgentAttempt[] = []): SuccessOutcome {
  return {
    provider: 'OPENAI',
    model: 'gpt-4o',
    content: 'hello',
    finishReason: 'stop',
    structured: null,
    latencyMs: 30,
    attempts,
    usage: {
      model: 'gpt-4o',
      provider: 'OPENAI',
      strategy: 'BALANCED',
      inputTokens: 10,
      outputTokens: 5,
      costUsdMicros: 40,
      latencyMs: 30,
      success: true,
      errorCode: null,
    },
  };
}

function failureOutcome(terminal: boolean): FailureOutcome {
  return {
    errorCode: 'RATE_LIMITED',
    errorMessage: 'slow down',
    latencyMs: 12,
    attempts: [],
    terminal,
    usage: {
      model: 'gpt-4o',
      provider: 'OPENAI',
      strategy: 'BALANCED',
      inputTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
      latencyMs: 12,
      success: false,
      errorCode: 'RATE_LIMITED',
    },
  };
}

describe('PrismaInferenceStore.startJob', () => {
  it('marks a queued job RUNNING and reports it ready', async () => {
    const tx = fakeTx();
    tx.inferenceJob.findUnique = vi.fn(async () => ({
      id: JOB_ID,
      conversationId: null,
      status: 'QUEUED',
      requestedModel: 'gpt-4o',
      provider: null,
      routingStrategy: 'BALANCED',
    }));

    const result = await storeFor(tx).startJob(TENANT, JOB_ID);

    expect(result).toEqual({
      kind: 'ready',
      job: {
        id: JOB_ID,
        conversationId: null,
        status: 'QUEUED',
        requestedModel: 'gpt-4o',
        provider: null,
        strategy: 'BALANCED',
      },
    });
    expect(tx.inferenceJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RUNNING' }) }),
    );
  });

  it('reports a missing row without writing', async () => {
    const tx = fakeTx();
    const result = await storeFor(tx).startJob(TENANT, JOB_ID);

    expect(result).toEqual({ kind: 'missing' });
    expect(tx.inferenceJob.update).not.toHaveBeenCalled();
  });

  it('refuses to restart a terminal job', async () => {
    const tx = fakeTx();
    tx.inferenceJob.findUnique = vi.fn(async () => ({
      id: JOB_ID,
      conversationId: null,
      status: 'SUCCEEDED',
      requestedModel: 'gpt-4o',
      provider: 'OPENAI',
      routingStrategy: 'BALANCED',
    }));

    const result = await storeFor(tx).startJob(TENANT, JOB_ID);

    expect(result).toEqual({ kind: 'terminal', status: 'SUCCEEDED' });
    expect(tx.inferenceJob.update).not.toHaveBeenCalled();
  });

  it('refuses a job that is still waiting on a human, without marking it RUNNING', async () => {
    const tx = fakeTx();
    tx.inferenceJob.findUnique = vi.fn(async () => ({
      id: JOB_ID,
      conversationId: null,
      status: 'AWAITING_APPROVAL',
      requestedModel: 'gpt-4o',
      provider: null,
      routingStrategy: 'BALANCED',
    }));

    const result = await storeFor(tx).startJob(TENANT, JOB_ID);

    // A job whose gate is closed is not authorised to run. The approval flow creates
    // the queue entry, so reaching here means something enqueued it early — a
    // producer bug, a stale replay, a job-id collision. Refusing here turns that
    // mistake into a log line instead of a provider call and an invoice, which is
    // the entire reason the row is the authority rather than the queue.
    expect(result).toEqual({ kind: 'awaiting_approval' });
    expect(tx.inferenceJob.update).not.toHaveBeenCalled();
  });

  it('does not increment attempts for an awaiting job, so a retry budget survives', async () => {
    const tx = fakeTx();
    tx.inferenceJob.findUnique = vi.fn(async () => ({
      id: JOB_ID,
      conversationId: null,
      status: 'AWAITING_APPROVAL',
      requestedModel: 'gpt-4o',
      provider: null,
      routingStrategy: 'BALANCED',
    }));

    await storeFor(tx).startJob(TENANT, JOB_ID);

    // Burning an attempt on a job that never ran would let a premature delivery
    // exhaust BullMQ's retries and dead-letter a job that is still legitimately
    // waiting for a person to click.
    expect(tx.inferenceJob.update).not.toHaveBeenCalled();
  });

  it('reports awaiting separately from terminal, so the refusal can be logged loudly', async () => {
    const awaiting = fakeTx();
    awaiting.inferenceJob.findUnique = vi.fn(async () => ({
      id: JOB_ID,
      conversationId: null,
      status: 'AWAITING_APPROVAL',
      requestedModel: 'gpt-4o',
      provider: null,
      routingStrategy: 'BALANCED',
    }));
    const terminal = fakeTx();
    terminal.inferenceJob.findUnique = vi.fn(async () => ({
      id: JOB_ID,
      conversationId: null,
      status: 'CANCELED',
      requestedModel: 'gpt-4o',
      provider: null,
      routingStrategy: 'BALANCED',
    }));

    const store = storeFor(awaiting);
    expect(await store.startJob(TENANT, JOB_ID)).not.toEqual(
      await storeFor(terminal).startJob(TENANT, JOB_ID),
    );

    // Both refuse to run, but only one of them indicates a bug. `terminal` is routine
    // at-least-once delivery; `awaiting_approval` is worth a warn line.
    expect(await storeFor(terminal).startJob(TENANT, JOB_ID)).toEqual({
      kind: 'terminal',
      status: 'CANCELED',
    });
  });
});

describe('PrismaInferenceStore.loadRoutingInputs', () => {
  it('joins catalogue rows with the tenant override and observed reliability', async () => {
    const tx = fakeTx();
    tx.tenantProvider.findMany = vi.fn(async () => [
      {
        modelId: MODEL_UUID,
        status: 'ENABLED',
        weight: 120,
        credentialRef: 'env:TEAM_OPENAI_KEY',
        priceMultiplierBps: 9_500,
      },
    ]);
    tx.providerAttempt.groupBy = vi.fn(async () => [
      { provider: 'OPENAI', model: 'gpt-4o', success: true, _count: { _all: 9 } },
      { provider: 'OPENAI', model: 'gpt-4o', success: false, _count: { _all: 1 } },
    ]);

    const inputs = await storeFor(tx).loadRoutingInputs(TENANT);

    expect(inputs.entitlements).toEqual(PLAN_ENTITLEMENTS[SubscriptionPlan.Enterprise]);
    expect(inputs.catalogue).toHaveLength(1);
    expect(inputs.catalogue[0]?.credentialRef).toBe('env:TEAM_OPENAI_KEY');
    expect(inputs.catalogue[0]?.model).toMatchObject({
      modelId: 'gpt-4o',
      provider: 'OPENAI',
      tenantStatus: 'ENABLED',
      tenantWeight: 120,
      priceMultiplierBps: 9_500,
      reliabilityScore: 9_000,
    });
  });

  it('leaves a model with no attempts unscored rather than scoring it zero', async () => {
    const tx = fakeTx();
    const inputs = await storeFor(tx).loadRoutingInputs(TENANT);

    expect(inputs.catalogue[0]?.model.reliabilityScore).toBeNull();
    expect(inputs.catalogue[0]?.credentialRef).toBeNull();
    expect(inputs.catalogue[0]?.model.tenantStatus).toBeNull();
  });

  it('throws when the tenant does not exist, rather than routing under a guessed plan', async () => {
    const tx = fakeTx();
    tx.tenant.findUnique = vi.fn(async () => null);

    await expect(storeFor(tx).loadRoutingInputs(TENANT)).rejects.toThrow(/does not exist/);
  });
});

describe('PrismaInferenceStore writes', () => {
  it('records a success with its cost, usage and attempt trail', async () => {
    const tx = fakeTx();
    const attempts: AgentAttempt[] = [
      {
        provider: 'OPENAI',
        model: 'gpt-4o',
        success: true,
        latencyMs: 12,
        errorCode: null,
        errorMessage: null,
      },
    ];

    await storeFor(tx).finishSuccess(TENANT, JOB_ID, successOutcome(attempts));

    expect(tx.inferenceJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          provider: 'OPENAI',
          costUsdMicros: 40,
        }),
      }),
    );
    expect(tx.providerAttempt.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ tenantId: TENANT, attemptNo: 1 })],
      }),
    );
    expect(tx.usageRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: TENANT, costUsdMicros: 40, success: true }),
      }),
    );
  });

  it('marks a terminal failure FAILED', async () => {
    const tx = fakeTx();
    await storeFor(tx).finishFailure(TENANT, JOB_ID, failureOutcome(true));

    expect(tx.inferenceJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'RATE_LIMITED' }),
      }),
    );
  });

  it('leaves a non-terminal failure QUEUED so BullMQ can still retry it', async () => {
    const tx = fakeTx();
    await storeFor(tx).finishFailure(TENANT, JOB_ID, failureOutcome(false));

    const data = vi.mocked(tx.inferenceJob.update).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data.status).toBe('QUEUED');
    expect(data.completedAt).toBeUndefined();
  });

  it('cancels without throwing when the row is already gone', async () => {
    const tx = fakeTx();
    await storeFor(tx).markCanceled(TENANT, JOB_ID);

    expect(tx.inferenceJob.updateMany).toHaveBeenCalled();
    expect(tx.inferenceJob.update).not.toHaveBeenCalled();
  });
});

describe('asAiProvider', () => {
  it('narrows the catalogue string to the provider enum it mirrors', () => {
    expect(asAiProvider('OPENAI')).toBe('OPENAI');
  });
});
