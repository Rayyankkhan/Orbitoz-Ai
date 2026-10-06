/**
 * The provider factory's one job: map an `AiProvider` onto a client dialect, and
 * refuse loudly for a provider with no implementation.
 *
 * The regression this locks in is `LOCAL`: it is OpenAI-compatible by definition,
 * has no host default worth trusting, and is keyless — so it must be both
 * buildable and reported as implemented, or every Local candidate is silently
 * dropped during routing.
 */
import { describe, expect, it } from 'vitest';
import {
  IMPLEMENTED_PROVIDERS,
  createProviderClient,
  defaultBaseUrl,
  isImplemented,
} from './factory.js';
import { respondingWith } from '../testing/transport.js';

const OPTIONS = { transport: respondingWith({ body: '{}' }).transport };

describe('isImplemented', () => {
  it('reports every provider with a client implementation', () => {
    expect([...IMPLEMENTED_PROVIDERS].sort()).toEqual(
      ['ANTHROPIC', 'AZURE_OPENAI', 'GOOGLE', 'LOCAL', 'MISTRAL', 'OPENAI'].sort(),
    );
  });

  it('reports LOCAL as implemented', () => {
    // LOCAL is keyless and OpenAI-compatible; dropping it would make every
    // self-hosted model unreachable even though the FREE plan allows it.
    expect(isImplemented('LOCAL')).toBe(true);
  });

  it('reports a provider with no dialect as unimplemented', () => {
    expect(isImplemented('COHERE')).toBe(false);
    expect(isImplemented('BEDROCK')).toBe(false);
    expect(isImplemented('VERTEX_AI')).toBe(false);
  });
});

describe('createProviderClient', () => {
  it('builds an OpenAI-compatible client for LOCAL', () => {
    const client = createProviderClient(
      'LOCAL',
      { baseUrl: defaultBaseUrl('LOCAL'), apiKey: '' },
      OPTIONS,
    );

    expect(client.provider).toBe('LOCAL');
  });

  it('rejects an empty base URL before any request is made', () => {
    expect(() =>
      createProviderClient('OPENAI', { baseUrl: '', apiKey: 'sk-test' }, OPTIONS),
    ).toThrow(/empty baseUrl/);
  });

  it('fails construction for a provider with no implemented dialect', () => {
    expect(() =>
      createProviderClient('COHERE', { baseUrl: defaultBaseUrl('COHERE'), apiKey: 'x' }, OPTIONS),
    ).toThrow(/no client implementation/);
  });
});
