/**
 * The routing engine: one request, several providers, one answer.
 *
 * The loop is: pick a candidate → call it with retry → on a failoverable failure,
 * move to the next candidate. Both behaviours are bounded independently, and the
 * distinction is what makes the cost predictable:
 *
 * - **Retries** stay on one provider. A 429 that clears in 2 seconds should not
 *   cost a failover to a model the tenant did not ask for.
 * - **Failover** changes provider. A provider that is genuinely down, or whose
 *   quota for this tenant is exhausted, will not clear within one request's life.
 *
 * Every attempt — success or failure — is recorded, because the audit trail is
 * what makes a bill defensible. A tenant disputing a charge needs to see which
 * providers were tried, in what order, at what cost, and which one answered.
 */
import { AiProviderError, AI_ERROR_CODE } from '../errors.js';
import { DEFAULT_BACKOFF, withRetry, type BackoffOptions, type Sleeper } from '../backoff.js';
import {
  computeCostUsdMicros,
  exceedsCostCeiling,
  usdToMicros,
  type ModelPricing,
} from '../cost.js';
import type { ProviderClient } from '../providers/contracts.js';
import type { RoutableModel } from '../routing.js';
import type { AgentAttempt, AgentResult } from '../agent-types.js';
import type { JsonSchema } from '../structured.js';
import type { ChatMessage, CompletionRequest } from '../providers/contracts.js';

export interface EngineRequest {
  readonly messages: readonly ChatMessage[];
  readonly candidates: readonly RoutableModel[];
  /** Resolves a client for one candidate. Injected; the engine holds no secrets. */
  readonly clientFor: (model: RoutableModel) => ProviderClient;
  readonly temperature?: number | null;
  readonly maxTokens?: number | null;
  readonly topP?: number | null;
  readonly stopSequences?: readonly string[] | null;
  /**
   * When present, every attempt asks the provider for JSON conforming to this
   * schema. Forwarded unchanged; the caller still parses and validates the text,
   * because a provider that ignores `response_format` returns prose and no error.
   */
  readonly responseSchema?: JsonSchema | null;
  /** Per-request deadline, per attempt. */
  readonly timeoutMs?: number;
  /** Cancellation from a drain or a cancelled job. */
  readonly signal?: AbortSignal;
  /** Hard ceiling on spend for this request. Exceeding it fails the request. */
  readonly maxCostUsd?: number | null;
  readonly backoff?: BackoffOptions;
  readonly sleep?: Sleeper;
  /** Called for every attempt, immediately, so nothing is lost on a later throw. */
  readonly onAttempt?: (attempt: AgentAttempt) => void | Promise<void>;
}

export interface EngineOutcome {
  readonly result: AgentResult;
  readonly attempts: readonly AgentAttempt[];
}

/**
 * Runs one request across the candidate list.
 *
 * @throws {AiProviderError} when every candidate has been exhausted. The thrown
 * error is the *last* real provider error where one exists, because that is the
 * one an operator needs — a timeout that was later followed by "model not
 * available" should surface the second, and a generic "all providers failed"
 * should never be what a DLQ entry says.
 */
export async function executeWithFailover(request: EngineRequest): Promise<EngineOutcome> {
  const backoff = request.backoff ?? DEFAULT_BACKOFF;
  const attempts: AgentAttempt[] = [];
  let lastError: AiProviderError | null = null;

  for (const model of request.candidates) {
    const client = request.clientFor(model);
    const pricing: ModelPricing = {
      inputCostPerMTokens: model.inputCostPerMTokens,
      outputCostPerMTokens: model.outputCostPerMTokens,
    };

    try {
      const completion = await withRetry(
        async () => {
          const started = Date.now();
          try {
            return await client.complete({
              model: model.modelId,
              messages: request.messages,
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
              ...(request.topP === undefined ? {} : { topP: request.topP }),
              ...(request.stopSequences === undefined
                ? {}
                : { stopSequences: request.stopSequences }),
              ...(request.responseSchema == null ? {} : { responseSchema: request.responseSchema }),
              ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
          } catch (error) {
            const failure = toProviderError(error, client, model.modelId);
            const record: AgentAttempt = {
              provider: String(client.provider),
              model: model.modelId,
              success: false,
              latencyMs: Date.now() - started,
              errorCode: failure.code,
              errorMessage: failure.message,
            };
            attempts.push(record);
            // Reported per attempt, not at the end: a worker that fails over after
            // four failed attempts must still have written those four rows, and
            // returning them only on success loses them precisely when they matter.
            await request.onAttempt?.(record);
            throw failure;
          }
        },
        { ...backoff, ...(request.sleep === undefined ? {} : { sleep: request.sleep }) },
      );

      const costUsdMicros = computeCostUsdMicros({
        pricing,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        ...(model.priceMultiplierBps === null
          ? {}
          : { priceMultiplierBps: model.priceMultiplierBps }),
      });

      // Recorded even on success, so the audit trail is complete: a row per
      // provider tried, not per outcome.
      const successRecord: AgentAttempt = {
        provider: String(client.provider),
        model: model.modelId,
        success: true,
        latencyMs: completion.latencyMs,
        errorCode: null,
        errorMessage: null,
      };
      attempts.push(successRecord);
      await request.onAttempt?.(successRecord);

      // A cost ceiling is checked after the call, not enforced during it: the
      // token count is unknown until the provider answers. Truncating `maxTokens`
      // to "probably fit" would return a truncated answer that looks complete,
      // which is worse than a clear failure.
      if (exceedsCostCeiling(costUsdMicros, toCeiling(request.maxCostUsd))) {
        throw new AiProviderError({
          code: AI_ERROR_CODE.InvalidRequest,
          message:
            `Request cost ${(costUsdMicros / 1e6).toFixed(6)} USD, exceeding the ` +
            `${(request.maxCostUsd ?? 0).toFixed(6)} USD ceiling.`,
          provider: String(client.provider),
          model: model.modelId,
        });
      }

      // A content-filtered stop with no text is a refusal, not an empty answer.
      // Recording it as a success would store a blank response and mark the job
      // succeeded, which is the failure mode a tenant can least detect.
      if (completion.finishReason === 'content_filter' && completion.text.trim() === '') {
        throw new AiProviderError({
          code: AI_ERROR_CODE.ContentFiltered,
          message: 'Provider refused the request with no content.',
          provider: String(client.provider),
          model: model.modelId,
        });
      }

      return {
        result: {
          text: completion.text,
          finishReason: completion.finishReason,
          provider: String(client.provider),
          model: model.modelId,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costUsdMicros,
          latencyMs: completion.latencyMs,
          structured: null,
          attempts: attempts.filter((attempt) => !attempt.success),
        },
        attempts,
      };
    } catch (error) {
      lastError = toProviderError(error, client, model.modelId);

      // A cost-ceiling rejection or a schema problem is not the provider's fault,
      // so failing over would just spend more money to reach the same conclusion.
      if (!lastError.failoverable) throw lastError;
    }
  }

  throw (
    lastError ??
    new AiProviderError({
      code: AI_ERROR_CODE.ModelUnavailable,
      message: `All ${request.candidates.length} candidate(s) failed without a recorded error.`,
    })
  );
}

function toCeiling(maxCostUsd: number | null | undefined): number | null {
  return maxCostUsd === null || maxCostUsd === undefined ? null : usdToMicros(maxCostUsd);
}

/**
 * Normalises anything thrown into an `AiProviderError`.
 *
 * A `ProviderClient` is supposed to throw only `AiProviderError`, but a transport
 * or a JSON parse in a third-party client can escape as anything. Without this,
 * one such escape skips the failover decision entirely — the error is not an
 * `AiProviderError`, so the catch block rethrows and a provider that would have
 * succeeded on the next candidate is never tried.
 */
export function toProviderError(
  error: unknown,
  client: ProviderClient,
  model: string,
): AiProviderError {
  if (error instanceof AiProviderError) return error;

  return new AiProviderError({
    code: AI_ERROR_CODE.NetworkError,
    message: error instanceof Error ? error.message : String(error),
    provider: String(client.provider),
    model,
    cause: error,
  });
}

export type { CompletionRequest };
