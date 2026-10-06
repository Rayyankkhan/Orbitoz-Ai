/**
 * Credential resolution for provider calls.
 *
 * `tenant_providers.credential_ref` is a *reference*, not a secret — the column is
 * `VARCHAR(255)` and holds something like `env:OPENAI_API_KEY` or, in production,
 * an AWS Secrets Manager / Vault path. A raw key never touches the table, and that
 * is a hard rule rather than a preference: one table row readable by an operator
 * with `SELECT` should not hand them every tenant's provider key.
 *
 * The worker resolves the reference at call time through {@link SecretStore}. The
 * default implementation reads environment variables, which is the smallest
 * thing that can be correct in development and a deliberate limitation in
 * production: the environment has exactly one value per variable, and there is
 * one key per tenant. A real deployment swaps in a store backed by the secrets
 * manager; the interface is the seam, and it exists so that swap is a constructor
 * argument rather than a change to the engine.
 */
import type { AiProvider } from '@orbitoz/shared-types';
import { defaultBaseUrl, type ProviderCredentials } from '@orbitoz/ai-engine';

/** Raised when a credential reference cannot be resolved. Never contains the value. */
export class CredentialError extends Error {
  constructor(
    message: string,
    readonly ref: string,
  ) {
    super(`${message} (ref: ${ref})`);
    this.name = 'CredentialError';
  }
}

export interface SecretStore {
  /**
   * Resolves a credential reference into provider credentials.
   *
   * @throws {CredentialError} when the reference is unresolvable or malformed.
   *   The engine treats that as a candidate-level failure and fails over, so one
   *   tenant's missing key does not fail a job another provider can serve.
   */
  resolve(ref: string | null, provider: AiProvider): Promise<ProviderCredentials>;
}

/** Providers whose requests are unauthenticated by design (self-hosted). */
const KEYLESS_PROVIDERS: readonly AiProvider[] = ['LOCAL'];

/**
 * Reads credentials from environment variables.
 *
 * Reference forms:
 *  - `env:NAME` — reads `NAME`.
 *  - `null` — reads the provider's conventional variable (`OPENAI_API_KEY`,
 *    `ANTHROPIC_API_KEY`, …), which is what a single-tenant development
 *    environment wants.
 *
 * Base URLs come from `<PROVIDER>_BASE_URL` when set, falling back to the
 * provider's documented default. Azure additionally reads `<PROVIDER>_DEPLOYMENT`
 * and `<PROVIDER>_API_VERSION`, because an Azure endpoint is a deployment rather
 * than a model path.
 */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  resolve(ref: string | null, provider: AiProvider): Promise<ProviderCredentials> {
    // Non-`async` on purpose: `require-await` forbids an `async` method with no
    // `await`, but the failure still has to arrive as a rejection. A synchronous
    // throw would escape a caller's `await`-based `try/catch`, so it is caught
    // here and converted.
    try {
      return Promise.resolve(this.resolveOrThrow(ref, provider));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resolveOrThrow(ref: string | null, provider: AiProvider): ProviderCredentials {
    const variable = this.variableFor(ref, provider);
    const apiKey = this.env[variable] ?? '';

    if (apiKey === '' && !KEYLESS_PROVIDERS.includes(provider)) {
      // Not swallowed: an empty key is a misconfiguration, and failing over is
      // the correct response so a tenant with one working provider is not
      // blocked by another's missing variable.
      throw new CredentialError(
        `No value is set for ${variable}; the provider cannot be called without a key.`,
        ref ?? variable,
      );
    }

    const baseUrl = this.env[`${provider}_BASE_URL`] ?? defaultBaseUrl(provider);
    const deployment = this.env[`${provider}_DEPLOYMENT`];
    const apiVersion = this.env[`${provider}_API_VERSION`];

    return {
      apiKey,
      baseUrl,
      ...(deployment === undefined ? {} : { deployment }),
      ...(apiVersion === undefined ? {} : { apiVersion }),
    };
  }

  private variableFor(ref: string | null, provider: AiProvider): string {
    if (ref === null) return `${provider}_API_KEY`;

    if (ref.startsWith('env:')) {
      const name = ref.slice('env:'.length);
      if (name === '') {
        throw new CredentialError('Credential reference "env:" names no variable.', ref);
      }
      return name;
    }

    // A scheme this store does not implement (aws-sm, gcp-sm, vault) is a hard
    // error, not a silent fallback to environment lookup: silently reading the
    // wrong key is worse than failing, because the failure is then attributed to
    // the provider rather than to the missing store.
    throw new CredentialError(
      `Unsupported credential reference scheme; this store resolves "env:" only.`,
      ref,
    );
  }
}
