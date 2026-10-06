/**
 * The Anthropic Messages client.
 *
 * Separate from the OpenAI-compatible client rather than a flag on it, because
 * the *shapes* differ in four places that each need a decision:
 *
 * - **System prompt is a top-level parameter**, not a message. Converting a
 *   system message into a user message produces a prompt the model was not
 *   written for, and the resulting quality loss is invisible.
 * - **Token limits are named `max_tokens` and are *required*.** OpenAI treats it
 *   as optional; Anthropic rejects a request without it, so a default has to be
 *   supplied here rather than omitted.
 * - **Stop sequences are `stop_sequences`.**
 * - **No `response_format`.** Structured output goes through extract-and-validate
 *   plus a repair turn, which is why `supportsStructuredOutput` excludes
 *   Anthropic rather than pretending otherwise.
 */
import { AiProviderError, codeForStatus, parseRetryAfter, AI_ERROR_CODE } from '../errors.js';
import { isAbortError, TransportNetworkError, type Transport } from '../transport.js';
import {
  DEFAULT_TIMEOUT_MS,
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type ProviderClient,
  type ProviderClientOptions,
} from './contracts.js';
import { extractErrorMessage } from './openai-compatible.js';

interface AnthropicResponseBody {
  readonly id?: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string | null;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export class AnthropicClient implements ProviderClient {
  readonly provider = 'ANTHROPIC' as const;

  private readonly credentials: ProviderClientOptions['credentials'];
  private readonly transport: Transport;
  private readonly defaultTimeoutMs: number;

  constructor(options: ProviderClientOptions) {
    this.credentials = options.credentials;
    this.transport = options.transport;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.credentials.baseUrl.replace(/\/+$/, '')}/messages`;
    const timeout = AbortSignal.timeout(request.timeoutMs ?? this.defaultTimeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);

    let response;
    try {
      response = await this.transport(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': this.credentials.anthropicVersion ?? '2023-06-01',
          ...(this.credentials.apiKey === '' ? {} : { 'x-api-key': this.credentials.apiKey }),
        },
        body: JSON.stringify(this.buildBody(request)),
        signal,
      });
    } catch (error) {
      throw this.classifyTransportError(error, request.model, request.signal ?? null);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AiProviderError({
        code: codeForStatus(response.status),
        message: extractErrorMessage(response.body) ?? `Provider returned HTTP ${response.status}.`,
        provider: this.provider,
        model: request.model,
        status: response.status,
        ...(() => {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          return retryAfterMs === null ? {} : { retryAfterMs };
        })(),
      });
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
      parsed as AnthropicResponseBody,
      request.model,
      response.latencyMs,
    );
  }

  private buildBody(request: CompletionRequest): Record<string, unknown> {
    // A system message becomes the top-level `system` parameter. Several system
    // messages are joined rather than dropped — the shared contract allows a list,
    // and silently discarding the second one would lose part of the prompt.
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content);
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      // Required, and there is no safe default in the API. 4096 is the documented
      // minimum that every current model accepts; a caller wanting more passes
      // `maxTokens` explicitly, and a workflow that needs a large document sets it
      // per node.
      max_tokens: request.maxTokens ?? 4_096,
    };

    if (system.length > 0) body.system = system.join('\n\n');
    if (request.temperature !== undefined && request.temperature !== null) {
      body.temperature = request.temperature;
    }
    if (request.topP !== undefined && request.topP !== null) body.top_p = request.topP;
    if (request.stopSequences !== undefined && request.stopSequences !== null) {
      body.stop_sequences = [...request.stopSequences];
    }

    // Deliberately no `response_format`. Anthropic has no JSON-mode parameter; the
    // engine gets structured output from extract-and-validate plus one repair
    // turn instead, and pretending otherwise would send a field the API rejects.
    return body;
  }

  private toCompletionResponse(
    body: AnthropicResponseBody,
    model: string,
    latencyMs: number,
  ): CompletionResponse {
    if (body.content === undefined) {
      throw new AiProviderError({
        code: AI_ERROR_CODE.MalformedResponse,
        message: 'Provider response contained no content array.',
        provider: this.provider,
        model,
        status: 200,
      });
    }

    // Concatenated rather than taking `[0]`: the content array is a list of typed
    // blocks, and a response split across text blocks is valid. Taking the first
    // block truncates the answer exactly when the model was being thorough.
    const text = body.content
      .filter((block) => block.type === 'text' || block.type === undefined)
      .map((block) => block.text ?? '')
      .join('');

    const finishReason = normaliseStopReason(body.stop_reason);

    return {
      text,
      finishReason,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
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
}

function normaliseStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    // `refusal` is a model declining, not a transport problem. Treated as a
    // filter so the caller does not retry a refusal into the same refusal.
    case 'refusal':
      return 'content_filter';
    // Enumerated rather than left to `default`: the exhaustiveness rule treats a
    // default as unable to prove a union is covered, and a missing reason is a
    // real case worth naming.
    case undefined:
    case null:
      return 'unknown';
    default:
      return 'unknown';
  }
}
