/**
 * Credential resolution.
 *
 * The claims under test are the ones that decide whether a job can be billed at
 * all: an `env:` reference is honoured, a missing key fails rather than sending an
 * empty bearer token, a scheme this store does not implement fails loudly instead
 * of silently reading the wrong variable, and a self-hosted provider is allowed
 * to be keyless.
 */
import { describe, expect, it } from 'vitest';
import { CredentialError, EnvSecretStore } from './credentials.js';

function store(env: Record<string, string | undefined>): EnvSecretStore {
  return new EnvSecretStore(env);
}

describe('EnvSecretStore', () => {
  it('reads a named variable from an env: reference', async () => {
    const credentials = await store({ MY_OPENAI_KEY: 'sk-123' }).resolve(
      'env:MY_OPENAI_KEY',
      'OPENAI',
    );

    expect(credentials.apiKey).toBe('sk-123');
    expect(credentials.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('falls back to the provider-conventional variable for a null reference', async () => {
    const credentials = await store({ OPENAI_API_KEY: 'sk-default' }).resolve(null, 'OPENAI');
    expect(credentials.apiKey).toBe('sk-default');
  });

  it('carries a base URL override for self-hosted and Azure endpoints', async () => {
    const credentials = await store({
      OPENAI_API_KEY: 'sk',
      OPENAI_BASE_URL: 'https://tenant.openai.azure.com',
    }).resolve(null, 'OPENAI');

    expect(credentials.baseUrl).toBe('https://tenant.openai.azure.com');
  });

  it('reads Azure deployment and API version when present', async () => {
    const credentials = await store({
      AZURE_OPENAI_API_KEY: 'sk',
      AZURE_OPENAI_DEPLOYMENT: 'gpt4o-prod',
      AZURE_OPENAI_API_VERSION: '2024-10-21',
    }).resolve(null, 'AZURE_OPENAI');

    expect(credentials.deployment).toBe('gpt4o-prod');
    expect(credentials.apiVersion).toBe('2024-10-21');
  });

  it('allows a keyless credential for a self-hosted provider', async () => {
    const credentials = await store({}).resolve(null, 'LOCAL');
    expect(credentials.apiKey).toBe('');
    expect(credentials.baseUrl).toBe('http://localhost:8000/v1');
  });

  it('fails when a required key is not set, rather than sending an empty bearer token', async () => {
    await expect(store({}).resolve(null, 'ANTHROPIC')).rejects.toBeInstanceOf(CredentialError);
  });

  it('fails when an env: reference names a variable that is not set', async () => {
    await expect(store({}).resolve('env:MISSING', 'OPENAI')).rejects.toBeInstanceOf(
      CredentialError,
    );
  });

  it('rejects an empty env: reference instead of resolving the empty string', async () => {
    await expect(store({}).resolve('env:', 'OPENAI')).rejects.toBeInstanceOf(CredentialError);
  });

  it('rejects an unimplemented scheme instead of silently falling back to the environment', async () => {
    // A vault path read as an environment variable would return undefined and the
    // failure would be attributed to the provider, not to the missing store.
    await expect(store({}).resolve('vault:secret/openai', 'OPENAI')).rejects.toBeInstanceOf(
      CredentialError,
    );
  });

  it('uses the reference in the error so a misconfiguration is identifiable without the secret', async () => {
    try {
      await store({}).resolve('env:TEAM_KEY', 'OPENAI');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as CredentialError).ref).toBe('env:TEAM_KEY');
      expect((error as CredentialError).message).not.toContain('sk-');
    }
  });
});

describe('EnvSecretStore provider type threading', () => {
  it('resolves each provider against its own conventional variable', async () => {
    const secrets = store({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', MISTRAL_API_KEY: 'm' });
    const openai = await secrets.resolve(null, 'OPENAI');
    const anthropic = await secrets.resolve(null, 'ANTHROPIC');
    const mistral = await secrets.resolve(null, 'MISTRAL');

    expect([openai.apiKey, anthropic.apiKey, mistral.apiKey]).toEqual(['o', 'a', 'm']);
  });
});
