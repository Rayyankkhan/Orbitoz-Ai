/**
 * Cost accounting.
 *
 * The only property that matters is that arithmetic stays exact and additive in
 * integer micro-USD: a float that drifts makes two runs over the same usage
 * disagree, and there is no "correct" one to pick.
 */
import { describe, expect, it } from 'vitest';
import {
  computeCostUsdMicros,
  exceedsCostCeiling,
  estimateCeilingCostUsdMicros,
  microsToUsdString,
  usdToMicros,
} from './cost.js';

const PRICING = { inputCostPerMTokens: 25_000, outputCostPerMTokens: 100_000 };

describe('computeCostUsdMicros', () => {
  it('converts token counts and prices to integer micro-USD', () => {
    // 1000 * 25000 / 10000 + 500 * 100000 / 10000 = 2500 + 5000.
    expect(computeCostUsdMicros({ pricing: PRICING, inputTokens: 1_000, outputTokens: 500 })).toBe(
      7_500,
    );
  });

  it('has no float drift: two runs agree exactly', () => {
    const first = computeCostUsdMicros({ pricing: PRICING, inputTokens: 333, outputTokens: 777 });
    const second = computeCostUsdMicros({ pricing: PRICING, inputTokens: 333, outputTokens: 777 });
    expect(first).toBe(second);
    expect(Number.isInteger(first)).toBe(true);
  });

  it('does not discard the fraction on a small job', () => {
    // 100 tokens at $2.50/M is 250 micros, not 0.
    expect(computeCostUsdMicros({ pricing: PRICING, inputTokens: 100, outputTokens: 0 })).toBe(250);
  });

  it('applies the tenant multiplier to the total', () => {
    const base = computeCostUsdMicros({ pricing: PRICING, inputTokens: 1_000, outputTokens: 500 });
    const marked = computeCostUsdMicros({
      pricing: PRICING,
      inputTokens: 1_000,
      outputTokens: 500,
      priceMultiplierBps: 12_500,
    });
    expect(marked).toBe(Math.round((base * 12_500) / 10_000));
  });

  it('refuses negative token counts rather than issuing a negative bill', () => {
    expect(() =>
      computeCostUsdMicros({ pricing: PRICING, inputTokens: -1, outputTokens: 0 }),
    ).toThrow(RangeError);
  });
});

describe('exceedsCostCeiling', () => {
  it('is false with no ceiling', () => {
    expect(exceedsCostCeiling(999_999, null)).toBe(false);
  });

  it('compares strictly above the ceiling', () => {
    expect(exceedsCostCeiling(1_001, 1_000)).toBe(true);
    expect(exceedsCostCeiling(1_000, 1_000)).toBe(false);
  });
});

describe('unit conversions', () => {
  it('round-trips USD through micros', () => {
    expect(usdToMicros(1.5)).toBe(1_500_000);
    expect(microsToUsdString(1_500_000)).toBe('1.500000');
  });

  it('estimates the worst-case cost before any call', () => {
    expect(estimateCeilingCostUsdMicros(PRICING, 1_000, 500)).toBe(7_500);
  });
});
