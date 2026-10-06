/**
 * The inference processor's two responsibilities.
 *
 * It is a thin translation from the BullMQ job onto the runner, plus the retry
 * policy. Both are worth pinning: the translation has to forward the queue's own
 * retry counters (which nothing else in the system knows), and the policy has to
 * agree with `TenantWorker`, or the persisted status and the queue's behaviour
 * diverge.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { AI_ERROR_CODE, AiProviderError } from '@orbitoz/ai-engine';
import { INFERENCE_JOB, type BaseJob, type InferenceJobPayload } from '@orbitoz/shared-types';
import type { JobContext } from '../context/job-context.js';
import type { InferenceRunner } from '../ai/inference-runner.js';
import { InferenceProcessor, inferenceShouldRetry } from './inference.processor.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function makePayload(): InferenceJobPayload {
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
  };
}

function makeJob(
  overrides: { name?: string; attemptsMade?: number; attempts?: number } = {},
): Job<BaseJob<InferenceJobPayload>> {
  return {
    id: 'job-1',
    name: overrides.name ?? INFERENCE_JOB.Route,
    data: {
      id: 'job-1',
      tenantId: TENANT,
      userId: null,
      traceId: 'trace-1',
      enqueuedAt: '2026-01-01T00:00:00.000Z',
      attempt: 0,
      payload: makePayload(),
    },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts },
  } as unknown as Job<BaseJob<InferenceJobPayload>>;
}

const context: JobContext = {
  tenantId: TENANT as JobContext['tenantId'],
  userId: null,
  traceId: 'trace-1',
  jobId: 'job-1',
};

describe('InferenceProcessor', () => {
  it('forwards the job identity, retry counters and payload to the runner', async () => {
    const run = vi.fn(async () => undefined);
    const processor = new InferenceProcessor({ run } as unknown as InferenceRunner);

    await processor.process(context, makeJob({ attemptsMade: 2, attempts: 4 }));

    expect(run).toHaveBeenCalledWith({
      tenantId: TENANT,
      jobId: 'job-1',
      jobName: INFERENCE_JOB.Route,
      attemptsMade: 2,
      maxAttempts: 4,
      payload: makePayload(),
    });
  });

  it('defaults maxAttempts to a single delivery when the queue set none', async () => {
    const run = vi.fn(async () => undefined);
    const processor = new InferenceProcessor({ run } as unknown as InferenceRunner);

    await processor.process(context, makeJob());

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 }));
  });
});

describe('inferenceShouldRetry', () => {
  it('retries a retryable provider error while the budget remains', () => {
    const error = new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'slow down' });
    expect(inferenceShouldRetry(error, 0, 4)).toBe(true);
  });

  it('stops when the budget is exhausted, even for a retryable error', () => {
    const error = new AiProviderError({ code: AI_ERROR_CODE.RateLimited, message: 'slow down' });
    expect(inferenceShouldRetry(error, 3, 4)).toBe(false);
  });

  it('stops immediately for a non-retryable error', () => {
    const error = new AiProviderError({
      code: AI_ERROR_CODE.InvalidRequest,
      message: 'bad request',
      failoverable: false,
    });
    expect(inferenceShouldRetry(error, 0, 4)).toBe(false);
  });
});
