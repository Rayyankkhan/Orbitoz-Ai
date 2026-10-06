/**
 * Building a `ProviderClient` for a catalogue entry.
 *
 * The factory is the one place that maps an `AiProvider` onto an API dialect, so
 * adding a provider is a two-line change here plus one client file rather than a
 * `switch` that grows in every caller.
 *
 * It resolves configuration from the database (via a resolver passed in by the
 * worker) and never reads an environment variable. Credentials come from
 * `tenant_providers.credential_ref`, resolved through the secrets manager — a raw
 * API key is not in `process.env` of a worker serving many tenants, because
 * `process.env` has exactly one value per variable name and there is one key per
 * tenant.
 */
import type { AiProvider } from '@orbitoz/shared-types';
import type { Transport } from '../transport.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';
import type { ProviderClient, ProviderCredentials } from './contracts.js';

export interface ClientFactoryOptions {
  readonly transport: Transport;
  readonly defaultTimeoutMs?: number;
}

/** Default base URLs. Overridable per tenant for Azure and self-hosted models. */
const DEFAULT_BASE_URLS: Readonly<Record<AiProvider, string>> = {
  OPENAI: 'https://api.openai.com/v1',
  AZURE_OPENAI: 'https://api.openai.com',
  ANTHROPIC: 'https://api.anthropic.com/v1',
  GOOGLE: 'https://generativelanguage.googleapis.com/v1beta',
  MISTRAL: 'https://api.mistral.ai/v1',
  COHERE: 'https://api.cohere.ai/v1',
  BEDROCK: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  VERTEX_AI: 'https://us-central1-aiplatform.googleapis.com',
  // Self-hosted, OpenAI-compatible (vLLM, llama.cpp, Ollama's OpenAI endpoint).
  // Not a hosted default: the base URL is always tenant-specific, so this value
  // exists only so the map is total and a missing override fails loudly.
  LOCAL: 'http://localhost:8000/v1',
};

export function defaultBaseUrl(provider: AiProvider): string {
  const url = DEFAULT_BASE_URLS[provider];
  if (url === undefined) {
    // Unreachable with the current enum, and deliberately loud rather than a
    // silent `undefined` base URL that produces a confusing fetch failure later.
    throw new Error(`No default base URL is known for provider ${provider}.`);
  }
  return url;
}

/**
 * The providers this codebase can actually talk to.
 *
 * Three of the nine enum members are not implemented — Cohere's, Bedrock's and
 * Vertex's APIs are not OpenAI-shaped, so each needs its own client. Rather than
 * return a client that silently speaks the wrong protocol, an unimplemented
 * provider is a hard error at construction time. A tenant who enables one gets a
 * clear failure on the job, not a malformed request and an inscrutable 400.
 *
 * `LOCAL` is OpenAI-compatible by definition (vLLM, llama.cpp, Ollama) and is
 * keyless; its base URL is always tenant-specific, so it is only reachable via a
 * `tenant_providers` override.
 */
const OPENAI_COMPATIBLE: readonly AiProvider[] = [
  'OPENAI',
  'AZURE_OPENAI',
  'MISTRAL',
  'GOOGLE',
  'LOCAL',
];
const NATIVE_CLIENTS: readonly AiProvider[] = ['ANTHROPIC'];

/** Every provider with a client implementation. */
export const IMPLEMENTED_PROVIDERS: readonly AiProvider[] = [
  ...OPENAI_COMPATIBLE,
  ...NATIVE_CLIENTS,
];

export function isImplemented(provider: AiProvider): boolean {
  return IMPLEMENTED_PROVIDERS.includes(provider);
}

/**
 * Builds the client for one provider.
 *
 * @throws when the provider has no implementation. Deliberately not a
 * `ProviderClient` stub: see {@link OPENAI_COMPATIBLE}.
 */
export function createProviderClient(
  provider: AiProvider,
  credentials: ProviderCredentials,
  options: ClientFactoryOptions,
): ProviderClient {
  if (credentials.baseUrl === '') {
    throw new Error(`Provider ${provider} was given an empty baseUrl.`);
  }

  if (provider === 'ANTHROPIC') {
    return new AnthropicClient({
      credentials,
      transport: options.transport,
      ...(options.defaultTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.defaultTimeoutMs }),
    });
  }

  if (OPENAI_COMPATIBLE.includes(provider)) {
    return new OpenAiCompatibleClient(provider, {
      credentials,
      transport: options.transport,
      ...(options.defaultTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.defaultTimeoutMs }),
    });
  }

  throw new Error(
    `Provider ${provider} has no client implementation. Implemented: ${IMPLEMENTED_PROVIDERS.join(', ')}. ` +
      'Add a client for it rather than routing OpenAI-shaped requests to a different API.',
  );
}
