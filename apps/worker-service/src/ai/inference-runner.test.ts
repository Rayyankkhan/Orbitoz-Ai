/**
 * The inference runner — orchestration without infrastructure.
 *
 * The runner is the only place the engine's pure failover meets tenancy, secrets
 * and persistence. These tests substitute all three, so what is under test is the
 * orchestration itself: which candidates are tried, what is recorded when a
 * provider call fails over, how a repair is billed, and — the one that is easiest
 * to get wrong — that a failure the database must not treat as terminal is written
 * as non-terminal so BullMQ can still retry it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AI_ERROR_CODE,
  AiProviderError,
  type CompletionResponse,
  type ProviderClient,
  type RoutableModel,
} from '@orbitoz/ai-engine';
import {
  INFERENCE_JOB,
  PLAN_ENTITLEMENTS,
  SubscriptionPlan,
  type AiProvider,
  type InferenceJobPayload,
} from '@orbitoz/shared-types';
import type { SecretStore } from './credentials.js';
import type {
  InferenceJobRecord,
  InferenceStore,
  RoutingInputs,
  StartResult,
} from './inference-store.js';
import { InferenceRunner } from './inference-runner.js';
import { inferenceShouldRetry } from '../worker/inference.processor.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const READY_JOB: InferenceJobRecord = {
  id: JOB_ID,
  conversationId: null,
  status: 'QUEUED',
  requestedModel: 'gpt-4o',
  provider: null,
  strategy: 'BALANCED',
};

function routable(
  overrides: Partial<RoutableModel> & Pick<RoutableModel, 'modelId' | 'provider'>,
): RoutableModel {
  return {
    displayName: null,
    capabilities: ['CHAT', 'STRUCTURED_OUTPUT'],
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    // Price units are USD per million tokens with four decimals: 25_000 = $2.50/M.
    // So 10 input + 5 output tokens costs (10*25_000 + 5*30_000)/10_000 = 40 micro-USD.
    inputCostPerMTokens: 25_000,
    outputCostPerMTokens: 30_000,
    qualityScore: 8_000,
    latencyScore: 8_000,
    isDeprecated: false,
    tenantStatus: null,
    tenantWeight: null,
    priceMultiplierBps: null,
    reliabilityScore: null,
    ...overrides,
  };
}

function inputs(catalogue: readonly RoutableModel[]): RoutingInputs {
  return {
    entitlements: PLAN_ENTITLEMENTS[SubscriptionPlan.Enterprise],
    catalogue: catalogue.map((model) => ({ model, credentialRef: null })),
  };
}

function payload(overrides: Partial<InferenceJobPayload> = {}): InferenceJobPayload {
  return {
    model: 'gpt-4o',
    provider: null,
    strategy: 'BALANCED',
    messages: [{ role: 'user', content: 'hi', name: null, toolCallId: null }],
    options: {
      temperature: null,
      maxTokens: null,
      topP: null,
      stopSequences: null,
      responseSchema: null,
    },
    fanout: 1,
    idempotencyKey: null,
    maxCostUsd: null,
    ...overrides,
  };
}

function completion(overrides: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text: 'hello',
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 12,
    requestId: null,
    truncated: false,
    ...overrides,
  };
}

/** A client that returns (or throws) its scripted steps, one per call. */
function scriptedClient(
  provider: AiProvider,
  steps: readonly (CompletionResponse | Error)[],
): ProviderClient {
  let index = 0;
  return {
    provider,
    complete: async () => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step === undefined) return completion();
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

function makeStore(
  overrides: {
    readonly start?: StartResult;
    readonly routing?: RoutingInputs;
  } = {},
): InferenceStore {
  return {
    startJob: vi.fn(async () => overrides.start ?? { kind: 'ready', job: READY_JOB }),
    loadRoutingInputs: vi.fn(
      async () =>
        overrides.routing ?? inputs([routable({ modelId: 'gpt-4o', provider: 'OPENAI' })]),
    ),
    markCanceled: vi.fn(async () => undefined),
    finishSuccess: vi.fn(async () => undefined),
    finishFailure: vi.fn(async () => undefined),
  };
}

const alwaysResolves: SecretStore = {
  resolve: () => Promise.resolve({ baseUrl: 'https://provider.test/v1', apiKey: 'sk-test' }),
};

function makeRunner(options: {
  readonly store: InferenceStore;
  readonly clientFactory: (provider: AiProvider) => ProviderClient;
  readonly secrets?: SecretStore;
  readonly shouldRetry?: (error: unknown, made: number, max: number) => boolean;
}): InferenceRunner {
  return new InferenceRunner({
    store: options.store,
    secrets: options.secrets ?? alwaysResolves,
    clientFactory: (provider) => options.clientFactory(provider),
    // No retries and no sleeps: failover is the behaviour under test, not backoff.
    backoff: { baseDelayMs: 0, maxDelayMs: 0, retries: 0 },
    shouldRetry: options.shouldRetry ?? inferenceShouldRetry,
    now: () => 1_000,
  });
}

async function run(
  runner: InferenceRunner,
  overrides: Partial<Parameters<InferenceRunner['run']>[0]> = {},
): Promise<void> {
  await runner.run({
    tenantId: TENANT,
    jobId: JOB_ID,
    jobName: INFERENCE_JOB.Route,
    attemptsMade: 0,
    maxAttempts: 4,
    payload: payload(),
    ...overrides,
  });
}

describe('InferenceRunner lifecycle', () => {
  it('cancels without calling a provider, and without starting the job', async () => {
    const store = makeStore();
    const clientFactory = vi.fn((provider: AiProvider) => scriptedClient(provider, []));

    await run(makeRunner({ store, clientFactory }), { jobName: INFERENCE_JOB.Cancel });

    expect(store.markCanceled).toHaveBeenCalledWith(TENANT, JOB_ID);
    expect(store.startJob).not.toHaveBeenCalled();
    expect(store.loadRoutingInputs).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('skips a job whose row no longer exists', async () => {
    const store = makeStore({ start: { kind: 'missing' } });

    await run(makeRunner({ store, clientFactory: (p) => scriptedClient(p, []) }));

    expect(store.loadRoutingInputs).not.toHaveBeenCalled();
    expect(store.finishSuccess).not.toHaveBeenCalled();
  });

  it('skips a job that is already terminal, so a duplicate delivery cannot re-bill', async () => {
    const store = makeStore({ start: { kind: 'terminal', status: 'SUCCEEDED' } });

    await run(makeRunner({ store, clientFactory: (p) => scriptedClient(p, []) }));

    expect(store.loadRoutingInputs).not.toHaveBeenCalled();
    expect(store.finishSuccess).not.toHaveBeenCalled();
  });

  it('refuses to call a provider for a job still awaiting approval', async () => {
    const store = makeStore({ start: { kind: 'awaiting_approval' } });
    const clientFactory = vi.fn((provider: AiProvider) => scriptedClient(provider, []));

    await run(makeRunner({ store, clientFactory }));

    // The gate is closed, so there is no authorisation to spend money. Nothing is
    // resolved, nothing is routed, nothing is persisted: the job stays exactly as the
    // approval flow left it.
    expect(clientFactory).not.toHaveBeenCalled();
    expect(store.loadRoutingInputs).not.toHaveBeenCalled();
    expect(store.finishSuccess).not.toHaveBeenCalled();
    expect(store.finishFailure).not.toHaveBeenCalled();
    expect(store.markCanceled).not.toHaveBeenCalled();
  });

  it('does not consume a retry for a job awaiting approval', async () => {
    const store = makeStore({ start: { kind: 'awaiting_approval' } });

    await run(makeRunner({ store, clientFactory: (p) => scriptedClient(p, []) }), {
      attemptsMade: 3,
      maxAttempts: 4,
    });

    // `run` returning normally is what marks the BullMQ attempt complete. Throwing
    // here would dead-letter a job that is still legitimately waiting on a person.
    expect(store.finishFailure).not.toHaveBeenCalled();
  });

  it('lets a cancellation win over an awaiting job', async () => {
    const store = makeStore({ start: { kind: 'awaiting_approval' } });

    await run(makeRunner({ store, clientFactory: (p) => scriptedClient(p, []) }), {
      jobName: INFERENCE_JOB.Cancel,
    });

    // The cancel branch runs before `startJob`, so a rejected approval cancels the
    // parked job through the one path that is allowed to write to it.
    expect(store.markCanceled).toHaveBeenCalledWith(TENANT, JOB_ID);
    expect(store.startJob).not.toHaveBeenCalled();
  });
});

describe('InferenceRunner success path', () => {
  it('persists the chosen provider, tokens, cost and attempt trail', async () => {
    const store = makeStore();
    const client = scriptedClient('OPENAI', [completion()]);

    await run(makeRunner({ store, clientFactory: () => client }));

    expect(store.finishSuccess).toHaveBeenCalledTimes(1);
    const outcome = vi.mocked(store.finishSuccess).mock.calls[0]![2];
    expect(outcome.provider).toBe('OPENAI');
    expect(outcome.model).toBe('gpt-4o');
    expect(outcome.content).toBe('hello');
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.usage.inputTokens).toBe(10);
    expect(outcome.usage.outputTokens).toBe(5);
    expect(outcome.usage.costUsdMicros).toBe(40);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ provider: 'OPENAI', success: true });
    expect(store.finishFailure).not.toHaveBeenCalled();
  });

  it('fails over to the next candidate when the first is rate limited', async () => {
    // The same logical model offered by two providers, so it can be pinned by name
    // and still fail over. Cost ordering puts OpenAI first.
    const store = makeStore({
      routing: inputs([
        routable({ modelId: 'gpt-4o', provider: 'OPENAI' }),
        routable({ modelId: 'gpt-4o', provider: 'ANTHROPIC', inputCostPerMTokens: 9_000_000 }),
      ]),
    });
    const clients: Record<string, ProviderClient> = {
      OPENAI: scriptedClient('OPENAI', [
        new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'slow down' }),
      ]),
      ANTHROPIC: scriptedClient('ANTHROPIC', [completion({ text: 'from claude' })]),
    };

    await run(makeRunner({ store, clientFactory: (p) => clients[p] ?? scriptedClient(p, []) }), {
      payload: payload({ model: 'gpt-4o', strategy: 'COST_OPTIMIZED', fanout: 2 }),
    });

    const outcome = vi.mocked(store.finishSuccess).mock.calls[0]![2];
    expect(outcome.provider).toBe('ANTHROPIC');
    expect(outcome.content).toBe('from claude');
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]).toMatchObject({ success: false, errorCode: 'RATE_LIMITED' });
    expect(outcome.attempts[1]).toMatchObject({ success: true, provider: 'ANTHROPIC' });
  });
});

describe('InferenceRunner structured output', () => {
  it('parses schema-valid output and records it', async () => {
    const store = makeStore();
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const client = scriptedClient('OPENAI', [completion({ text: '{"title":"Hello"}' })]);

    await run(makeRunner({ store, clientFactory: () => client }), {
      payload: payload({ options: { ...payload().options, responseSchema: schema } }),
    });

    const outcome = vi.mocked(store.finishSuccess).mock.calls[0]![2];
    expect(outcome.structured).toEqual({ title: 'Hello' });
  });

  it('runs one repair turn and bills it as part of the request', async () => {
    const store = makeStore();
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const client = scriptedClient('OPENAI', [
      completion({ text: 'no json here' }),
      completion({ text: '{"title":"Fixed"}', inputTokens: 3, outputTokens: 4 }),
    ]);

    await run(makeRunner({ store, clientFactory: () => client }), {
      payload: payload({ options: { ...payload().options, responseSchema: schema } }),
    });

    const outcome = vi.mocked(store.finishSuccess).mock.calls[0]![2];
    expect(outcome.structured).toEqual({ title: 'Fixed' });
    expect(outcome.usage.inputTokens).toBe(13);
    expect(outcome.usage.outputTokens).toBe(9);
    expect(outcome.attempts).toHaveLength(2);
  });

  it('fails without repairing when the output was truncated at max_tokens', async () => {
    const store = makeStore();
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const complete = vi.fn(async () => completion({ text: '{"title": "unclosed' }));
    const client: ProviderClient = { provider: 'OPENAI', complete };

    await expect(
      run(makeRunner({ store, clientFactory: () => client }), {
        payload: payload({ options: { ...payload().options, responseSchema: schema } }),
      }),
    ).rejects.toBeInstanceOf(AiProviderError);

    // One call only: a repair would reproduce the same truncation.
    expect(complete).toHaveBeenCalledTimes(1);
    const failure = vi.mocked(store.finishFailure).mock.calls[0]![2];
    expect(failure.errorCode).toBe(AI_ERROR_CODE.StructuredOutputInvalid);
  });
});

describe('InferenceRunner failure handling', () => {
  it('rejects a responseSchema that is not an object schema before routing', async () => {
    const store = makeStore();
    const clientFactory = vi.fn((provider: AiProvider) => scriptedClient(provider, []));

    await expect(
      run(makeRunner({ store, clientFactory }), {
        payload: payload({ options: { ...payload().options, responseSchema: { type: 'array' } } }),
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODE.InvalidRequest });

    expect(clientFactory).not.toHaveBeenCalled();
    expect(store.finishSuccess).not.toHaveBeenCalled();
  });

  it('fails a request whose only candidate has no resolvable credential', async () => {
    const store = makeStore();
    const secrets: SecretStore = {
      resolve: () => Promise.reject(new Error('no key')),
    };
    const clientFactory = vi.fn((provider: AiProvider) => scriptedClient(provider, []));

    await expect(run(makeRunner({ store, clientFactory, secrets }))).rejects.toMatchObject({
      code: AI_ERROR_CODE.ModelUnavailable,
    });

    expect(clientFactory).not.toHaveBeenCalled();
    expect(store.finishFailure).toHaveBeenCalledTimes(1);
  });

  it('writes a terminal failure when the retry policy says stop', async () => {
    const store = makeStore();
    const client = scriptedClient('OPENAI', [
      new AiProviderError({
        code: AI_ERROR_CODE.InvalidRequest,
        message: 'bad request',
        failoverable: false,
      }),
    ]);

    await expect(run(makeRunner({ store, clientFactory: () => client }))).rejects.toBeInstanceOf(
      AiProviderError,
    );

    const failure = vi.mocked(store.finishFailure).mock.calls[0]![2];
    expect(failure.terminal).toBe(true);
    expect(failure.errorCode).toBe(AI_ERROR_CODE.InvalidRequest);
  });

  it('writes a non-terminal failure while the retry budget remains', async () => {
    const store = makeStore();
    const client = scriptedClient('OPENAI', [
      new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'slow down' }),
    ]);

    await expect(
      run(makeRunner({ store, clientFactory: () => client }), { attemptsMade: 1, maxAttempts: 4 }),
    ).rejects.toBeInstanceOf(AiProviderError);

    const failure = vi.mocked(store.finishFailure).mock.calls[0]![2];
    expect(failure.terminal).toBe(false);
  });
});
