/**
 * Provider routing.
 *
 * The router's job is to turn a request plus a tenant's entitlements into an
 * *ordered* list of candidates. Order matters as much as membership: the first
 * candidate is attempted, and if it fails in a failoverable way the second is.
 * That ordering is the entire difference between a failover policy and a random
 * one.
 *
 * Filtering comes before ordering, and every filter is an entitlement or a
 * capability check rather than a preference:
 *
 * 1. The tenant's plan permits the provider and the strategy.
 * 2. The tenant has enabled the model (`tenant_providers.status = ENABLED`).
 * 3. The model supports the capability the request needs.
 * 4. The model's context window fits the prompt.
 * 5. The model is not deprecated.
 *
 * A filter that fails is not a deprioritised candidate. "Deprioritise models
 * that are too small for this prompt" sounds reasonable and is a data leak: the
 * job runs on a cheap model, produces a truncated answer, and the tenant never
 * learns why. Too small means not eligible.
 */
import type { AiProvider, PlanEntitlement, RoutingStrategy } from '@orbitoz/shared-types';
import { AiProviderError, AI_ERROR_CODE } from './errors.js';
import {
  estimateTokens,
  supportsStructuredOutput,
  type ChatMessage,
} from './providers/contracts.js';

/** A catalogue entry, joined with the tenant's override if one exists. */
export interface RoutableModel {
  readonly modelId: string;
  readonly provider: string;
  readonly displayName: string | null;
  readonly capabilities: readonly string[];
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly inputCostPerMTokens: number;
  readonly outputCostPerMTokens: number;
  /** 0..10000. */
  readonly qualityScore: number;
  /** 0..10000. */
  readonly latencyScore: number;
  readonly isDeprecated: boolean;
  /** From `tenant_providers.status`. Absent means enabled by default. */
  readonly tenantStatus: 'ENABLED' | 'DISABLED' | null;
  /** From `tenant_providers.weight`. Absent means 100. */
  readonly tenantWeight: number | null;
  /** From `tenant_providers.price_multiplier_bps`. Absent means list price. */
  readonly priceMultiplierBps: number | null;
  /**
   * Observed success rate, 0..10000, from `provider_attempts` for this tenant.
   *
   * Null when there is no history. Null is treated as neutral rather than as
   * zero, because a model with no attempts has not failed — scoring it as 0%
   * reliable would send every new tenant to whichever model happened to be
   * queried first.
   */
  readonly reliabilityScore: number | null;
}

export interface RoutingRequest {
  /** A model id the tenant pinned. Restricts the candidate set. */
  readonly requestedModel: string | null;
  /** A provider the tenant pinned. Restricts the candidate set. */
  readonly requestedProvider: AiProvider | null;
  readonly strategy: RoutingStrategy;
  readonly messages: readonly ChatMessage[];
  /** When true, only models with native structured output are eligible. */
  readonly requiresStructuredOutput: boolean;
  /** How many candidates to return. The engine attempts them in order. */
  readonly fanout: number;
  readonly entitlements: PlanEntitlement;
}

export interface RouteResult {
  readonly candidates: readonly RoutableModel[];
  /** Why the list is what it is. Empty when the list is non-empty. */
  readonly rejections: readonly string[];
}

/**
 * Filters and orders candidates.
 *
 * @throws {AiProviderError} when nothing is eligible. The message names the
 * filters that removed everything, because "no provider available" is
 * unactionable for a tenant and "the model you pinned is not enabled for your
 * plan" is a support ticket that resolves itself.
 */
export function routeModels(
  request: RoutingRequest,
  catalogue: readonly RoutableModel[],
): RouteResult {
  const rejections: string[] = [];
  const promptTokens = estimateTokens(request.messages);

  const eligible = catalogue.filter((model) => {
    if (request.requestedModel !== null && model.modelId !== request.requestedModel) {
      rejections.push(`${model.modelId}: not the requested model`);
      return false;
    }
    if (request.requestedProvider !== null && upper(model.provider) !== request.requestedProvider) {
      rejections.push(`${model.modelId}: provider not requested`);
      return false;
    }

    // Plan entitlement. A provider the tenant's plan does not include is not
    // available to them regardless of what the catalogue says.
    const provider = upper(model.provider);
    if (!request.entitlements.allowedProviders.includes(provider)) {
      rejections.push(`${model.modelId}: provider ${provider} not in plan entitlements`);
      return false;
    }

    if (model.tenantStatus === 'DISABLED') {
      rejections.push(`${model.modelId}: disabled for this tenant`);
      return false;
    }

    if (model.isDeprecated) {
      rejections.push(`${model.modelId}: deprecated`);
      return false;
    }

    if (
      request.requiresStructuredOutput &&
      !supportsStructuredOutput(provider, model.capabilities)
    ) {
      rejections.push(`${model.modelId}: no structured output support`);
      return false;
    }

    if (model.contextWindow !== null) {
      // The window covers the prompt *and* the expected completion. Checking only
      // the prompt lets a 100k-token prompt route to a 128k model, which then
      // fails at generation time because there is no room left to answer.
      const roomForOutput = Math.min(model.maxOutputTokens ?? 0, 8_192);
      if (promptTokens + roomForOutput > model.contextWindow) {
        rejections.push(
          `${model.modelId}: prompt (~${promptTokens} tokens) exceeds context window ${model.contextWindow}`,
        );
        return false;
      }
    }

    return true;
  });

  if (eligible.length === 0) {
    throw new AiProviderError({
      code: AI_ERROR_CODE.ModelUnavailable,
      message:
        `No model satisfies this request for the tenant's plan. ` +
        `Tried ${catalogue.length} catalogue entries; ${describeRejections(rejections)}.`,
    });
  }

  const ordered = orderCandidates(eligible, request.strategy);
  return { candidates: ordered.slice(0, Math.max(1, request.fanout)), rejections };
}

/**
 * Orders by strategy.
 *
 * Each comparator returns a score where *higher is better*, then ties break
 * deterministically. Determinism matters more than it looks: two workers routing
 * the same request must agree, or the same prompt is billed at two different
 * prices depending on which worker picked it up.
 */
function orderCandidates(
  models: readonly RoutableModel[],
  strategy: RoutingStrategy,
): RoutableModel[] {
  const scored = models.map((model) => ({ model, score: scoreFor(model, strategy) }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable, meaningful tie-break: cost, then model id. Cheaper first is a better
    // default than alphabetical, and model id last makes the order total.
    const costA = totalCostPerMTokens(a.model);
    const costB = totalCostPerMTokens(b.model);
    if (costA !== costB) return costA - costB;
    return a.model.modelId.localeCompare(b.model.modelId);
  });

  return scored.map((entry) => entry.model);
}

function scoreFor(model: RoutableModel, strategy: RoutingStrategy): number {
  switch (strategy) {
    case 'FIXED':
      // The tenant pinned this model. Anything scoring higher would be disobeying
      // an explicit instruction; anything lower is irrelevant.
      return 0;

    case 'COST_OPTIMIZED':
      return -totalCostPerMTokens(model);

    case 'QUALITY_OPTIMIZED':
      return model.qualityScore;

    case 'LATENCY_OPTIMIZED':
      return model.latencyScore;

    case 'BALANCED': {
      // Three components, weighted. Quality leads because a cheap wrong answer
      // costs the tenant more than an expensive right one; cost is the tie-breaker
      // of last resort. Reliability is folded in with a large weight — a model
      // that failed three times in a row should not be first choice again.
      const reliability = model.reliabilityScore ?? 5_000; // Neutral, not zero.
      return (
        model.qualityScore * 2 + reliability + model.latencyScore - totalCostPerMTokens(model) / 10
      );
    }

    case 'FAILOVER': {
      // The tenant pinned a model but accepts a different one. Reliability leads,
      // because the point of this strategy is to avoid the model that just failed.
      const reliability = model.reliabilityScore ?? 5_000;
      const weight = model.tenantWeight ?? 100;
      return reliability + weight;
    }

    default: {
      // Exhaustiveness guard. A new strategy added to the enum without a rule here
      // would otherwise fall through to 0 for every model and route alphabetically
      // — silently, and looking like it worked.
      const _exhaustive: never = strategy;
      throw new Error(`Unhandled routing strategy: ${String(_exhaustive)}`);
    }
  }
}

/**
 * An approximate blended price per million tokens.
 *
 * A 3:1 input:output weighting, which is the usual ratio for chat traffic. Exact
 * cost uses the real counts (`computeCostUsdMicros`); this only has to be
 * comparable *between* models, so an approximation that ranks correctly is enough
 * and keeps the comparator cheap enough to run per request.
 */
function totalCostPerMTokens(model: RoutableModel): number {
  return model.inputCostPerMTokens + model.outputCostPerMTokens * 3;
}

function upper(value: string): AiProvider {
  return value.toUpperCase() as AiProvider;
}

/**
 * Summarises rejections for an error message.
 *
 * Grouped by reason and capped, because an error listing 400 rejected models
 * buries the one line that says why. The cap keeps the message inside a
 * `error_message VARCHAR(2000)` when it is persisted.
 */
function describeRejections(rejections: readonly string[]): string {
  if (rejections.length === 0) return 'the catalogue was empty';

  const counts = new Map<string, number>();
  for (const rejection of rejections) {
    // Strip the model id so identical reasons collapse.
    const reason = rejection.replace(/^[^:]*: /, '');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  const summary = [...counts.entries()].map(([reason, count]) => `${reason} (${count})`).join('; ');

  return summary.length > 1_000 ? `${summary.slice(0, 997)}...` : summary;
}
