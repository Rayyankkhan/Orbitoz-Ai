/**
 * Cost accounting.
 *
 * Money is counted in **integer micro-USD** (`costUsdMicros`), never in floats.
 * `0.1 + 0.2 !== 0.3` in IEEE-754, and a billing system that sums floats
 * eventually disagrees with itself: two runs over the same usage produce different
 * invoices, and neither can be called the wrong one. The database stores
 * `cost_usd_micros` for exactly this reason.
 *
 * The catalogue stores prices as USD per million tokens with four decimal places
 * — `25_000` means $2.50 — so one unit is $0.0001. Both scales are integer, and
 * the conversion between them is exact:
 *
 *   micros = tokens * priceUnits / 10_000
 *
 * Checked: 1M tokens at `25_000` → `1_000_000 * 25_000 / 10_000` = 2_500_000
 * micros = $2.50. Correct, and no float touched.
 */

/** Prices in USD per million tokens, 4 decimal places. `25_000` = $2.50. */
export interface ModelPricing {
  readonly inputCostPerMTokens: number;
  readonly outputCostPerMTokens: number;
}

export interface CostInput {
  readonly pricing: ModelPricing;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Tenant price multiplier in basis points. `10_000` is list price; `12_500` is
   * list plus 25%.
   */
  readonly priceMultiplierBps?: number;
}

/**
 * Computes the cost of one completion, in micro-USD.
 *
 * Rounded at each step with `Math.round`, and the multiplication is done before
 * the division so the intermediate is not truncated per token. Doing
 * `tokens / 1e6 * price` first would discard the fraction on every call and
 * accumulate a visible bias across a month's usage; a job of 100 tokens at $2.50
 * per million should cost 250 micros, not 0.
 *
 * The tenant multiplier applies to the total, so a negotiated rate cannot differ
 * between input and output. Applying it per component would let a rounding
 * difference appear in the output price for a tenant whose multiplier is not a
 * round number, which is exactly the kind of discrepancy nobody notices until an
 * invoice is questioned.
 */
export function computeCostUsdMicros(input: CostInput): number {
  const { pricing, inputTokens, outputTokens } = input;

  if (inputTokens < 0 || outputTokens < 0) {
    // Negative token counts come from a provider reporting nonsense. Clamping to
    // zero is better than a negative bill that an operator has to chase.
    throw new RangeError(
      `Token counts must be non-negative; received input=${inputTokens} output=${outputTokens}.`,
    );
  }

  const raw =
    (inputTokens * pricing.inputCostPerMTokens + outputTokens * pricing.outputCostPerMTokens) /
    10_000;

  const multiplierBps = input.priceMultiplierBps ?? 10_000;
  const withMultiplier = Math.round((raw * multiplierBps) / 10_000);

  return Math.max(0, withMultiplier);
}

/** Micro-USD to a USD string, for logs and API responses. Never for arithmetic. */
export function microsToUsdString(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

/**
 * Whether a completion exceeded a cost ceiling.
 *
 * Checked *after* the call, because a ceiling cannot be enforced before it: the
 * token count is unknown until the provider answers. Enforcing it by truncating
 * `maxTokens` is a bound, not a guarantee — a request can cost less than its
 * limit, and refusing to start a cheap request because it *might* be expensive
 * fails tenants whose whole prompt is 200 tokens.
 *
 * So the ceiling is a rejection, not a truncation: the job is failed and the cost
 * recorded, and the tenant sees a clear error rather than a silently truncated
 * answer that looks complete.
 */
export function exceedsCostCeiling(
  costUsdMicros: number,
  ceilingUsdMicros: number | null,
): boolean {
  if (ceilingUsdMicros === null) return false;
  return costUsdMicros > ceilingUsdMicros;
}

/** USD to micro-USD, for turning a request's `maxCostUsd` into the internal unit. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/**
 * Worst-case cost of a request, used to reject before spending anything.
 *
 * Bounded by the model's context window and `maxTokens`, whichever is smaller: a
 * provider will never bill more tokens than it accepts. Used as a pre-flight check
 * so an obviously unaffordable request fails without a round trip.
 */
export function estimateCeilingCostUsdMicros(
  pricing: ModelPricing,
  maxInputTokens: number,
  maxOutputTokens: number,
  priceMultiplierBps = 10_000,
): number {
  return computeCostUsdMicros({
    pricing,
    inputTokens: maxInputTokens,
    outputTokens: maxOutputTokens,
    priceMultiplierBps,
  });
}
