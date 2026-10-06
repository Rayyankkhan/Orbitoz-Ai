/**
 * The failover engine.
 *
 * Every test here is about *control flow on failure*: retry the same provider,
 * fail over to the next, or stop entirely. Those three are easy to conflate and
 * expensive to conflate — retrying a 400 four times, or failing over when the
 * primary was one second from recovering, are the two classic bugs. The engine's
 * whole job is to keep them apart, so the tests are written around the error
 * classes that drive the distinction.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RoutableModel } from '../routing.js';
import { AI_ERROR_CODE, AiProviderError } from '../errors.js';
import { executeWithFailover } from './executor.js';
import { completion, ScriptedClient } from '../testing/transport.js';

function model(overrides: Partial<RoutableModel> = {}): RoutableModel {
  return {
    modelId: 'gpt-4o',
    provider: 'OPENAI',
    displayName: null,
    capabilities: ['chat'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerMTokens: 25_000,
    outputCostPerMTokens: 100_000,
    qualityScore: 8_000,
    latencyScore: 6_000,
    isDeprecated: false,
    tenantStatus: 'ENABLED',
    tenantWeight: 100,
    priceMultiplierBps: null,
    reliabilityScore: null,
    ...overrides,
  };
}

/** Never wait: the engine's sleeps are injected precisely so tests need not. */
const NO_SLEEP = (): Promise<void> => Promise.resolve();

describe('executeWithFailover', () => {
  it('returns the first success and records a single successful attempt', async () => {
    const client = new ScriptedClient('OPENAI', [completion({ text: 'done' })]);
    const outcome = await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model()],
      clientFor: () => client,
      sleep: NO_SLEEP,
    });

    expect(outcome.result.text).toBe('done');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({
      success: true,
      provider: 'OPENAI',
      model: 'gpt-4o',
    });
  });

  it('fails over to the next candidate after a failoverable failure', async () => {
    const primary = new ScriptedClient('OPENAI', [
      new AiProviderError({
        code: AI_ERROR_CODE.RateLimited,
        message: 'quota',
        provider: 'OPENAI',
      }),
    ]);
    const secondary = new ScriptedClient('ANTHROPIC', [completion({ text: 'from claude' })]);

    const outcome = await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model(), model({ provider: 'ANTHROPIC', modelId: 'claude-sonnet-4-5' })],
      clientFor: (candidate) => (candidate.provider === 'OPENAI' ? primary : secondary),
      backoff: { baseDelayMs: 0, maxDelayMs: 0, retries: 0 },
      sleep: NO_SLEEP,
    });

    expect(outcome.result.text).toBe('from claude');
    expect(outcome.result.provider).toBe('ANTHROPIC');
    // The failed attempt is in the audit trail, so the bill is defensible.
    expect(outcome.attempts.map((attempt) => attempt.success)).toEqual([false, true]);
    expect(outcome.attempts[0]?.errorCode).toBe(AI_ERROR_CODE.RateLimited);
  });

  it('does not fail over on a non-failoverable error', async () => {
    const primary = new ScriptedClient('OPENAI', [
      new AiProviderError({
        code: AI_ERROR_CODE.InvalidRequest,
        message: 'bad request',
        provider: 'OPENAI',
      }),
    ]);
    const secondary = new ScriptedClient('ANTHROPIC', [completion()]);
    const clientFor = vi.fn((candidate: RoutableModel) =>
      candidate.provider === 'OPENAI' ? primary : secondary,
    );

    await expect(
      executeWithFailover({
        messages: [{ role: 'user', content: 'hi' }],
        candidates: [model(), model({ provider: 'ANTHROPIC', modelId: 'claude' })],
        clientFor,
        backoff: { baseDelayMs: 0, maxDelayMs: 0, retries: 3 },
        sleep: NO_SLEEP,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODE.InvalidRequest });

    // The second candidate must never have been resolved: failing over would
    // spend another provider's tokens to reach the same conclusion.
    expect(clientFor).toHaveBeenCalledTimes(1);
    expect(secondary.calls).toHaveLength(0);
  });

  it('retries the same provider up to the retry budget before failing over', async () => {
    // A 429 should not immediately cost a failover; the same provider may clear.
    const primary = new ScriptedClient('OPENAI', [
      new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: '1', provider: 'OPENAI' }),
      new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: '2', provider: 'OPENAI' }),
      completion({ text: 'recovered' }),
    ]);

    const outcome = await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model()],
      clientFor: () => primary,
      backoff: { baseDelayMs: 0, maxDelayMs: 0, retries: 3 },
      sleep: NO_SLEEP,
    });

    expect(outcome.result.text).toBe('recovered');
    expect(primary.calls).toHaveLength(3);
    expect(outcome.attempts.filter((attempt) => !attempt.success)).toHaveLength(2);
  });

  it('reports the last real provider error when every candidate is exhausted', async () => {
    const primary = new ScriptedClient('OPENAI', [
      new AiProviderError({
        code: AI_ERROR_CODE.ProviderUnavailable,
        message: 'openai down',
        provider: 'OPENAI',
      }),
    ]);
    const secondary = new ScriptedClient('ANTHROPIC', [
      new AiProviderError({
        code: AI_ERROR_CODE.ModelUnavailable,
        message: 'model gone',
        provider: 'ANTHROPIC',
      }),
    ]);

    const error = await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model(), model({ provider: 'ANTHROPIC', modelId: 'claude' })],
      clientFor: (candidate) => (candidate.provider === 'OPENAI' ? primary : secondary),
      backoff: { baseDelayMs: 0, maxDelayMs: 0, retries: 0 },
      sleep: NO_SLEEP,
    }).catch((thrown: unknown) => thrown);

    // The *last* error, not "all providers failed": an operator needs the real one.
    expect((error as AiProviderError).message).toBe('model gone');
  });

  it('reports each attempt immediately via onAttempt', async () => {
    const seen: string[] = [];
    const client = new ScriptedClient('OPENAI', [
      new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'x', provider: 'OPENAI' }),
      completion(),
    ]);

    await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model()],
      clientFor: () => client,
      backoff: { baseDelayMs: 0, maxDelayMs: 0, retries: 3 },
      sleep: NO_SLEEP,
      onAttempt: (attempt) => {
        seen.push(attempt.success ? 'ok' : 'fail');
      },
    });

    // Order matters: a worker writes a row per attempt, and the failure must be
    // persisted before the retry, not batched until the end.
    expect(seen).toEqual(['fail', 'ok']);
  });

  it('computes cost in integer micro-USD from the model pricing', async () => {
    const client = new ScriptedClient('OPENAI', [
      completion({ inputTokens: 1_000, outputTokens: 500 }),
    ]);

    const outcome = await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model({ inputCostPerMTokens: 25_000, outputCostPerMTokens: 100_000 })],
      clientFor: () => client,
      sleep: NO_SLEEP,
    });

    // 1000 * 25000 / 10000 + 500 * 100000 / 10000 = 2500 + 5000 = 7500 micros.
    expect(outcome.result.costUsdMicros).toBe(7_500);
  });

  it('rejects a cost-ceiling breach instead of returning an overpriced answer', async () => {
    const client = new ScriptedClient('OPENAI', [
      completion({ inputTokens: 1_000_000, outputTokens: 0 }),
    ]);

    await expect(
      executeWithFailover({
        messages: [{ role: 'user', content: 'hi' }],
        candidates: [model({ inputCostPerMTokens: 25_000 })],
        clientFor: () => client,
        maxCostUsd: 0.001,
        sleep: NO_SLEEP,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODE.InvalidRequest, failoverable: false });
  });

  it('treats a content-filtered empty answer as a refusal, not a success', async () => {
    const client = new ScriptedClient('OPENAI', [
      completion({ text: '   ', finishReason: 'content_filter' }),
    ]);

    await expect(
      executeWithFailover({
        messages: [{ role: 'user', content: 'hi' }],
        candidates: [model()],
        clientFor: () => client,
        sleep: NO_SLEEP,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODE.ContentFiltered });
  });

  it('forwards the response schema to the provider', async () => {
    const client = new ScriptedClient('OPENAI', [completion()]);
    await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model()],
      clientFor: () => client,
      responseSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      sleep: NO_SLEEP,
    });

    expect(client.calls[0]?.responseSchema).toMatchObject({ type: 'object' });
  });

  it('normalises a non-provider throw into a failoverable network error', async () => {
    const client = new ScriptedClient('OPENAI', [new Error('socket exploded')]);

    const error = await executeWithFailover({
      messages: [{ role: 'user', content: 'hi' }],
      candidates: [model()],
      clientFor: () => client,
      backoff: { baseDelayMs: 0, maxDelayMs: 0, retries: 0 },
      sleep: NO_SLEEP,
    }).catch((thrown: unknown) => thrown);

    // Without normalisation this escapes as a plain Error, skipping failover.
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe(AI_ERROR_CODE.NetworkError);
  });
});
