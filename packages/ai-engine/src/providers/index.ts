/**
 * Provider client implementations.
 *
 * The barrel exists so `src/index.ts` exports one path per concern, and so the
 * engine never imports a concrete client — only the `ProviderClient` interface.
 */

export { AnthropicClient } from './anthropic.js';

export { extractErrorMessage, OpenAiCompatibleClient, userMessage } from './openai-compatible.js';

export {
  createProviderClient,
  defaultBaseUrl,
  IMPLEMENTED_PROVIDERS,
  isImplemented,
  type ClientFactoryOptions,
} from './factory.js';

export {
  CHARS_PER_TOKEN_ESTIMATE,
  DEFAULT_TIMEOUT_MS,
  estimateTokens,
  supportsStructuredOutput,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type ProviderClient,
  type ProviderClientOptions,
  type ProviderCredentials,
  type RoutingOutcome,
} from './contracts.js';
