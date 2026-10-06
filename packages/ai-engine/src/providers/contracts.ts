/**
 * Provider client contracts.
 *
 * One interface, two implementations. The value is not abstraction for its own
 * sake — it is that the *caller* never learns which provider it is talking to,
 * and therefore cannot accidentally branch on provider identity. Two places that
 * know the provider names are the routing layer (by design) and these two files.
 */

import type { AiProvider, RoutingStrategy } from '@orbitoz/shared-types';
import type { JsonSchema } from '../structured.js';
import type { Transport } from '../transport.js';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  /** Provider-native model id, e.g. `gpt-4o` or `claude-sonnet-4-5`. */
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number | null;
  readonly maxTokens?: number | null;
  readonly topP?: number | null;
  readonly stopSequences?: readonly string[] | null;
  /** When present, the provider is asked for JSON conforming to this schema. */
  readonly responseSchema?: JsonSchema | null;
  /** Per-request deadline. Overrides the client default. */
  readonly timeoutMs?: number;
  /** Caller cancellation — a cancelled job, or a drained worker. */
  readonly signal?: AbortSignal;
}

export type FinishReason =
  'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' | 'unknown';

export interface CompletionResponse {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  /** Provider request id, for correlating with the provider's own logs. */
  readonly requestId: string | null;
  /**
   * True when the model stopped because it hit `max_tokens`.
   *
   * Separate from the response because it is the single most common cause of a
   * `StructuredOutputError`: the document was valid JSON right up to the point
   * the output was cut off, and the repair prompt is the wrong response. The
   * caller should raise `maxTokens` instead.
   */
  readonly truncated: boolean;
}

export interface ProviderClient {
  readonly provider: AiProvider;
  /** Performs one completion. Throws `AiProviderError` on any failure. */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** Per-provider configuration resolved from the database and secrets manager. */
export interface ProviderCredentials {
  /** Provider-native base URL. Overridable for Azure and self-hosted models. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Provider-native deployment/model path, Azure only. */
  readonly deployment?: string;
  /** Provider-native API version, Azure only. */
  readonly apiVersion?: string;
  /** Anthropic's `anthropic-version` header. */
  readonly anthropicVersion?: string;
}

export interface ProviderClientOptions {
  readonly credentials: ProviderCredentials;
  readonly transport: Transport;
  readonly defaultTimeoutMs?: number;
  /**
   * Overrides the `api_key` sent. Only for tests and for the `local` provider,
   * where the "credential" is a placeholder rather than a secret.
   */
  readonly apiKeyHeader?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Rough characters-per-token, used to reject an over-long prompt before the
 * provider charges for it.
 *
 * Deliberately conservative (3.5) and deliberately an *estimate*. The exact
 * count is the provider's tokenizer, which is not available here; this exists to
 * avoid routing a 500k-character prompt to a 8k-token model and collecting a
 * `ContextLengthExceeded` for the round trip. Over-estimating means routing to a
 * larger window than needed, which costs nothing.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 3.5;

/** Estimates the prompt tokens a message list will occupy. */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let characters = 0;
  for (const message of messages) {
    // +4 per message: the role and delimiter overhead every provider adds.
    characters += message.content.length + 4;
  }
  return Math.ceil(characters / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Whether this client can be asked for schema-constrained output.
 *
 * Routed on, not assumed: sending `response_format` to a provider that ignores it
 * produces an unconstrained completion that then fails validation, which reads as
 * a model failure rather than a capability gap.
 */
export function supportsStructuredOutput(
  provider: AiProvider,
  capabilities: readonly string[],
): boolean {
  const normalised = capabilities.map((capability) => capability.toLowerCase());
  if (normalised.includes('json_mode') || normalised.includes('structured_output')) return true;

  // Every provider is listed rather than falling through a default: the
  // exhaustiveness rule will not accept a default as proof that a union is
  // covered, and a new provider added to the enum must force a deliberate
  // decision here rather than silently inheriting "no structured output".
  switch (provider) {
    case 'OPENAI':
    case 'AZURE_OPENAI':
    case 'MISTRAL':
      return true;
    // Anthropic has no `response_format`, so it takes the extract-and-validate
    // path. The rest either lack a JSON mode or are unimplemented.
    case 'ANTHROPIC':
    case 'GOOGLE':
    case 'COHERE':
    case 'BEDROCK':
    case 'VERTEX_AI':
    case 'LOCAL':
      return false;
  }
}

/** Which strategy a routing decision made, for the audit trail. */
export interface RoutingOutcome {
  readonly provider: AiProvider;
  readonly model: string;
  readonly strategy: RoutingStrategy;
  /** Why this candidate beat the others. Logged, never shown to a tenant. */
  readonly reason: string;
}
