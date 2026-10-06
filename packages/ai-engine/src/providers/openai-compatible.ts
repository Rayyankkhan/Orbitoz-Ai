/**
 * The OpenAI-compatible chat client.
 *
 * "Compatible" covers OpenAI itself, Azure OpenAI, Mistral, Groq, Together,
 * vLLM, Ollama's OpenAI endpoint, and most of the rest. One implementation
 * instead of seven is worth it only because the differences are confined to
 * three places, all handled below:
 *
 * - the URL (`/chat/completions`, or an Azure deployment path)
 * - the auth header (`Authorization: Bearer`, or `api-key`)
 * - an optional `api-version` query parameter
 *
 * The request and response shapes are otherwise identical, which is the entire
 * reason the compatibility claim is credible.
 */
import type { AiProvider } from '@orbitoz/shared-types';
import { AiProviderError, codeForStatus, parseRetryAfter, AI_ERROR_CODE } from '../errors.js';
import { isAbortError, TransportNetworkError, type Transport } from '../transport.js';
import {
  DEFAULT_TIMEOUT_MS,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type ProviderClient,
  type ProviderClientOptions,
} from './contracts.js';

/** The upstream shape. Narrowed to the fields actually read. */
interface OpenAiResponseBody {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
  readonly id?: string;
  readonly error?: { readonly message?: string; readonly code?: string };
}

export class OpenAiCompatibleClient implements ProviderClient {
  readonly provider: AiProvider;

  private readonly credentials: ProviderClientOptions['credentials'];
  private readonly transport: Transport;
  private readonly defaultTimeoutMs: number;
  private readonly apiKeyHeaderName: string;

  constructor(provider: AiProvider, options: ProviderClientOptions) {
    this.provider = provider;
    this.credentials = options.credentials;
    this.transport = options.transport;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Azure and every OpenAI-compatible service use `Authorization: Bearer`,
    // except Azure itself, which uses `api-key`. Detected by the presence of a
    // deployment rather than by the provider name, so a self-hosted gateway that
    // mimics Azure's path works without a code change here.
    this.apiKeyHeaderName =
      options.apiKeyHeader ??
      (this.credentials.deployment !== undefined ? 'api-key' : 'authorization');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const url = this.buildUrl();
    const body = this.buildBody(request);
    const headers = this.buildHeaders();

    // Two abort sources, one signal: the caller's cancellation and our own
    // deadline. `AbortSignal.any` composes them, and it matters that they compose
    // rather than replace — a drained worker cancels via `signal`, and a slow
    // provider trips the timeout, and losing either one means a job that cannot
    // be stopped or a job that never times out.
    const timeout = AbortSignal.timeout(request.timeoutMs ?? this.defaultTimeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);

    let response;
    try {
      response = await this.transport(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw this.classifyTransportError(error, request.model, request.signal ?? null);
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.classifyHttpError(
        response.status,
        response.headers.get('retry-after'),
        response.body,
        request.model,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch (error) {
      throw new AiProviderError({
        code: AI_ERROR_CODE.MalformedResponse,
        message: 'Provider returned a 2xx body that is not JSON.',
        provider: this.provider,
        model: request.model,
        status: response.status,
        cause: error,
      });
    }

    return this.toCompletionResponse(
      parsed as OpenAiResponseBody,
      request.model,
      response.latencyMs,
    );
  }

  private buildUrl(): string {
    const base = this.credentials.baseUrl.replace(/\/+$/, '');

    // Azure addresses a *deployment*, not a model, and takes the API version as a
    // query parameter. `deployment` is optional so a misconfigured Azure tenant
    // fails with a clear URL error rather than a 404 from the wrong path.
    if (this.credentials.deployment !== undefined) {
      const apiVersion = this.credentials.apiVersion ?? '2024-10-21';
      return `${base}/openai/deployments/${this.credentials.deployment}/chat/completions?api-version=${apiVersion}`;
    }

    return `${base}/chat/completions`;
  }

  private buildBody(request: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    };

    // Omitted rather than sent as null. OpenAI rejects an explicit null for
    // `temperature`, and sending one to a provider that tolerates it still
    // means sending a field the API documents as optional.
    if (request.temperature !== undefined && request.temperature !== null) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined && request.maxTokens !== null) {
      // `max_completion_tokens` is the current field; `max_tokens` is still
      // accepted by OpenAI and is the only field several compatible providers
      // understand. Sending the legacy name keeps this one client working across
      // all of them.
      body.max_tokens = request.maxTokens;
    }
    if (request.topP !== undefined && request.topP !== null) body.top_p = request.topP;
    if (request.stopSequences !== undefined && request.stopSequences !== null) {
      body.stop = [...request.stopSequences];
    }

    if (request.responseSchema != null) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: request.responseSchema,
        },
      };
    }

    return body;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // A self-hosted model may have no credential at all. Sending
    // `Authorization: ` with an empty value is rejected by several gateways,
    // which is a worse failure than omitting the header.
    if (this.credentials.apiKey !== '') {
      headers[this.apiKeyHeaderName] =
        this.apiKeyHeaderName === 'authorization'
          ? `Bearer ${this.credentials.apiKey}`
          : this.credentials.apiKey;
    }
    return headers;
  }

  private toCompletionResponse(
    body: OpenAiResponseBody,
    model: string,
    latencyMs: number,
  ): CompletionResponse {
    // A 200 with an `error` body happens on some gateways that proxy an error
    // response with a 200 status. Treating it as success would record a provider
    // attempt with zero output tokens and no error, which is worse than useless
    // in an audit trail.
    if (body.error !== undefined) {
      throw new AiProviderError({
        code: AI_ERROR_CODE.MalformedResponse,
        message: body.error.message ?? 'Provider returned a 2xx body containing an error object.',
        provider: this.provider,
        model,
        status: 200,
      });
    }

    const choice = body.choices?.[0];
    if (choice === undefined) {
      throw new AiProviderError({
        code: AI_ERROR_CODE.MalformedResponse,
        message: 'Provider response contained no choices.',
        provider: this.provider,
        model,
        status: 200,
      });
    }

    const finishReason = normaliseFinishReason(choice.finish_reason);
    const content = choice.message?.content ?? '';

    return {
      // Null content on a content-filtered response is not an empty completion —
      // reporting "" would store a successful empty answer.
      text: content,
      finishReason,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      latencyMs,
      requestId: body.id ?? null,
      truncated: finishReason === 'length',
    };
  }

  private classifyTransportError(
    error: unknown,
    model: string,
    callerSignal: AbortSignal | null,
  ): AiProviderError {
    if (error instanceof TransportNetworkError) {
      return new AiProviderError({
        code: AI_ERROR_CODE.NetworkError,
        message: error.message,
        provider: this.provider,
        model,
        cause: error.cause,
      });
    }

    if (isAbortError(error)) {
      // Distinguish *our* deadline from the caller's cancellation. The caller's
      // cancellation is a drain or a job cancellation and must not be retried —
      // retrying a cancelled job is how a worker refuses to shut down. The
      // caller-owned signal is checked directly rather than the composed one,
      // which is ambiguous: `AbortSignal.any` reports itself aborted for either
      // cause.
      if (callerSignal?.aborted === true) {
        return new AiProviderError({
          code: AI_ERROR_CODE.Timeout,
          message: 'Request was cancelled by the caller.',
          provider: this.provider,
          model,
          retryable: false,
          failoverable: false,
          cause: error,
        });
      }
      return new AiProviderError({
        code: AI_ERROR_CODE.Timeout,
        message: 'Provider did not respond within the request deadline.',
        provider: this.provider,
        model,
        cause: error,
      });
    }

    return new AiProviderError({
      code: AI_ERROR_CODE.NetworkError,
      message: error instanceof Error ? error.message : String(error),
      provider: this.provider,
      model,
      cause: error,
    });
  }

  private classifyHttpError(
    status: number,
    retryAfterHeader: string | null,
    rawBody: string,
    model: string,
  ): AiProviderError {
    const retryAfterMs = parseRetryAfter(retryAfterHeader);
    // Extract the provider's own message when it sent one: "Rate limit reached for
    // gpt-4o in organization org-xxx on tokens per min" tells an operator which
    // limit they hit, where "HTTP 429" does not.
    const detail = extractErrorMessage(rawBody);

    return new AiProviderError({
      code: codeForStatus(status),
      message: detail ?? `Provider returned HTTP ${status}.`,
      provider: this.provider,
      model,
      status,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    });
  }
}

/** Reads `error.message` from a provider error body, without trusting its shape. */
export function extractErrorMessage(rawBody: string): string | null {
  if (rawBody.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { readonly error?: unknown }).error;
      if (typeof error === 'string' && error !== '') return error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as { readonly message?: unknown }).message;
        if (typeof message === 'string' && message !== '') return message;
      }
      const message = (parsed as { readonly message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
    }
    // Some gateways return plain text or HTML. A truncated HTML body in an error
    // message is noise; the first line is enough context.
    const firstLine = rawBody.split('\n', 1)[0]?.trim() ?? '';
    return firstLine.length > 0 && firstLine.length <= 300 ? firstLine : null;
  } catch {
    const firstLine = rawBody.split('\n', 1)[0]?.trim() ?? '';
    return firstLine.length > 0 && firstLine.length <= 300 ? firstLine : null;
  }
}

function normaliseFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
    case 'safety':
      return 'content_filter';
    // `function_call` is the older OpenAI name for the same thing.
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case undefined:
    case null:
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Convenience for a single user message. */
export function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}
