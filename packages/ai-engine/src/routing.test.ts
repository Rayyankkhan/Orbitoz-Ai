/**
 * Provider routing.
 *
 * Membership is an entitlement check, never a preference: a model that is too
 * small, deprecated, or outside the tenant's plan is *ineligible*, not
 * deprioritised. Ordering is the only place a preference belongs.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_ENTITLEMENTS } from '@orbitoz/shared-types';
import { routeModels, type RoutableModel, type RoutingRequest } from './routing.js';
import { AI_ERROR_CODE } from './errors.js';

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

const ENTITLEMENTS = PLAN_ENTITLEMENTS.GROWTH;

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    requestedModel: null,
    requestedProvider: null,
    strategy: 'BALANCED',
    messages: [{ role: 'user', content: 'hi' }],
    requiresStructuredOutput: false,
    fanout: 3,
    entitlements: ENTITLEMENTS,
    ...overrides,
  };
}

describe('routeModels filtering', () => {
  it('drops a provider the plan does not entitle', () => {
    const free = PLAN_ENTITLEMENTS.FREE;
    // Free does not include Anthropic.
    expect(() =>
      routeModels(request({ entitlements: free }), [
        model({ provider: 'ANTHROPIC', modelId: 'claude' }),
      ]),
    ).toThrow(/not in plan entitlements/);
  });

  it('drops a model disabled for the tenant', () => {
    expect(() => routeModels(request(), [model({ tenantStatus: 'DISABLED' })])).toThrow(
      /disabled for this tenant/,
    );
  });

  it('drops a deprecated model', () => {
    expect(() => routeModels(request(), [model({ isDeprecated: true })])).toThrow(/deprecated/);
  });

  it('drops a model that cannot produce structured output when it is required', () => {
    expect(() =>
      routeModels(request({ requiresStructuredOutput: true }), [
        model({ provider: 'ANTHROPIC', modelId: 'claude' }),
      ]),
    ).toThrow(/structured output/);
  });

  it('drops a model whose context window cannot hold prompt plus output', () => {
    expect(() => routeModels(request(), [model({ contextWindow: 10, modelId: 'tiny' })])).toThrow(
      /context window/,
    );
  });

  it('restricts to a requested model', () => {
    const result = routeModels(request({ requestedModel: 'gpt-4o-mini' }), [
      model({ modelId: 'gpt-4o' }),
      model({ modelId: 'gpt-4o-mini' }),
    ]);
    expect(result.candidates.map((candidate) => candidate.modelId)).toEqual(['gpt-4o-mini']);
  });

  it('names the filters that removed everything in the error', () => {
    const error = (() => {
      try {
        routeModels(request(), [model({ isDeprecated: true })]);
        return null;
      } catch (thrown: unknown) {
        return thrown as Error;
      }
    })();
    expect(error?.message).toContain('deprecated');
  });
});

describe('routeModels ordering', () => {
  const cheap = model({
    modelId: 'cheap',
    inputCostPerMTokens: 1_000,
    outputCostPerMTokens: 1_000,
    qualityScore: 3_000,
  });
  const strong = model({
    modelId: 'strong',
    inputCostPerMTokens: 50_000,
    outputCostPerMTokens: 200_000,
    qualityScore: 9_500,
  });
  const fast = model({
    modelId: 'fast',
    inputCostPerMTokens: 2_000,
    outputCostPerMTokens: 2_000,
    latencyScore: 9_900,
  });

  it('puts the cheapest first under COST_OPTIMIZED', () => {
    const result = routeModels(request({ strategy: 'COST_OPTIMIZED' }), [strong, cheap, fast]);
    expect(result.candidates[0]?.modelId).toBe('cheap');
  });

  it('puts the highest quality first under QUALITY_OPTIMIZED', () => {
    const result = routeModels(request({ strategy: 'QUALITY_OPTIMIZED' }), [strong, cheap, fast]);
    expect(result.candidates[0]?.modelId).toBe('strong');
  });

  it('puts the lowest latency first under LATENCY_OPTIMIZED', () => {
    const result = routeModels(request({ strategy: 'LATENCY_OPTIMIZED' }), [strong, cheap, fast]);
    expect(result.candidates[0]?.modelId).toBe('fast');
  });

  it('is deterministic, breaking ties by cost then model id', () => {
    const a = model({
      modelId: 'aaa',
      inputCostPerMTokens: 5_000,
      outputCostPerMTokens: 5_000,
      qualityScore: 5_000,
    });
    const b = model({
      modelId: 'bbb',
      inputCostPerMTokens: 5_000,
      outputCostPerMTokens: 5_000,
      qualityScore: 5_000,
    });
    // Same score, same cost: the id makes the order total, so two workers agree.
    const first = routeModels(request({ strategy: 'BALANCED' }), [b, a]);
    const second = routeModels(request({ strategy: 'BALANCED' }), [a, b]);
    expect(first.candidates.map((candidate) => candidate.modelId)).toEqual(
      second.candidates.map((candidate) => candidate.modelId),
    );
  });

  it('folds reliability into BALANCED so a failing model is not first again', () => {
    const healthy = model({ modelId: 'healthy', qualityScore: 8_000, reliabilityScore: 9_500 });
    const flaky = model({ modelId: 'flaky', qualityScore: 8_000, reliabilityScore: 1_000 });
    const result = routeModels(request({ strategy: 'BALANCED' }), [flaky, healthy]);
    expect(result.candidates[0]?.modelId).toBe('healthy');
  });

  it('truncates to the requested fanout', () => {
    const result = routeModels(request({ strategy: 'COST_OPTIMIZED', fanout: 1 }), [
      strong,
      cheap,
      fast,
    ]);
    expect(result.candidates).toHaveLength(1);
  });

  it('throws MODEL_UNAVAILABLE when the catalogue is empty', () => {
    expect(() => routeModels(request(), [])).toThrow(
      expect.objectContaining({ code: AI_ERROR_CODE.ModelUnavailable }),
    );
  });
});
