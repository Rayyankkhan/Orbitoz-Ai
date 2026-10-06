/**
 * The OpenAI-compatible client, against a substituted transport.
 *
 * What is under test is the *transformation*: the request body this client
 * builds from a `CompletionRequest`, and the `CompletionResponse` it builds from
 * the provider's JSON. Both directions are where a compatibility claim is either
 * true or false — the same client serving OpenAI, Azure, Mistral and a
 * self-hosted vLLM.
 */
import { describe, expect, it } from 'vitest';
import { AI_ERROR_CODE, AiProviderError } from '../errors.js';
import { TransportNetworkError } from '../transport.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';
import { fakeTransport, respondingWith } from '../testing/transport.js';

const CREDENTIALS = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' };

function client(transport: ReturnType<typeof respondingWith>['transport']) {
  return new OpenAiCompatibleClient('OPENAI', { credentials: CREDENTIALS, transport });
}

describe('OpenAiCompatibleClient request transformation', () => {
  it('sends the model and messages, and posts to /chat/completions', async () => {
    const fake = respondingWith({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    });
    await client(fake.transport).complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(fake.requests[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(fake.requests[0]?.init.method).toBe('POST');
    expect(fake.requests[0]?.body).toMatchObject({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('omits optional sampling fields rather than sending null', async () => {
    // OpenAI rejects an explicit null temperature; a provider that tolerates it
    // still receives a field the API documents as optional.
    const fake = respondingWith({
      body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }),
    });
    await client(fake.transport).complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: null,
      maxTokens: null,
    });

    const body = fake.requests[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('sends a Bearer authorization header when a key is present', async () => {
    const fake = respondingWith({
      body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }),
    });
    await client(fake.transport).complete({ model: 'gpt-4o', messages: [] });

    expect(fake.requests[0]?.init.headers.authorization).toBe('Bearer sk-test');
  });

  it('omits the auth header entirely for a local model with no key', async () => {
    // Several gateways reject `Authorization: ` with an empty value, which is a
    // worse failure than omitting the header.
    const fake = respondingWith({
      body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }),
    });
    const local = new OpenAiCompatibleClient('LOCAL', {
      credentials: { baseUrl: 'http://localhost:8000/v1', apiKey: '' },
      transport: fake.transport,
    });
    await local.complete({ model: 'llama-3', messages: [] });

    expect(fake.requests[0]?.init.headers).not.toHaveProperty('authorization');
  });

  it('sends a strict json_schema response_format when a schema is supplied', async () => {
    const fake = respondingWith({
      body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
    });
    await client(fake.transport).complete({
      model: 'gpt-4o',
      messages: [],
      responseSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    });

    const body = fake.requests[0]?.body as Record<string, unknown>;
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'response', strict: true },
    });
  });

  it('addresses an Azure deployment by URL instead of a model path', async () => {
    const fake = respondingWith({
      body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }),
    });
    const azure = new OpenAiCompatibleClient('AZURE_OPENAI', {
      credentials: {
        baseUrl: 'https://acme.openai.azure.com',
        apiKey: 'azure-key',
        deployment: 'gpt-4o-deploy',
        apiVersion: '2024-08-01-preview',
      },
      transport: fake.transport,
    });
    await azure.complete({ model: 'gpt-4o', messages: [] });

    expect(fake.requests[0]?.url).toBe(
      'https://acme.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-08-01-preview',
    );
  });

  it('uses api-key for Azure rather than Authorization', async () => {
    const fake = respondingWith({
      body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }),
    });
    const azure = new OpenAiCompatibleClient('AZURE_OPENAI', {
      credentials: {
        baseUrl: 'https://acme.openai.azure.com',
        apiKey: 'azure-key',
        deployment: 'gpt-4o-deploy',
      },
      transport: fake.transport,
    });
    await azure.complete({ model: 'gpt-4o', messages: [] });

    expect(fake.requests[0]?.init.headers['api-key']).toBe('azure-key');
    expect(fake.requests[0]?.init.headers).not.toHaveProperty('authorization');
  });
});

describe('OpenAiCompatibleClient response transformation', () => {
  it('maps content, usage and finish_reason into a CompletionResponse', async () => {
    const fake = respondingWith({
      body: JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    });
    const response = await client(fake.transport).complete({ model: 'gpt-4o', messages: [] });

    expect(response).toMatchObject({
      text: 'the answer',
      finishReason: 'stop',
      inputTokens: 11,
      outputTokens: 7,
      requestId: 'chatcmpl-1',
      truncated: false,
    });
  });

  it('marks a length finish reason as truncated', async () => {
    const fake = respondingWith({
      body: JSON.stringify({
        choices: [{ message: { content: '{partial' }, finish_reason: 'length' }],
      }),
    });
    const response = await client(fake.transport).complete({ model: 'gpt-4o', messages: [] });

    expect(response.finishReason).toBe('length');
    expect(response.truncated).toBe(true);
  });

  it('treats a 2xx body carrying an error object as a failure', async () => {
    // Some gateways proxy an error with a 200 status. Recording it as success
    // would write a zero-token provider attempt with no error to the audit trail.
    const fake = respondingWith({
      body: JSON.stringify({ error: { message: 'quota exceeded' } }),
    });

    await expect(
      client(fake.transport).complete({ model: 'gpt-4o', messages: [] }),
    ).rejects.toMatchObject({
      code: AI_ERROR_CODE.MalformedResponse,
      message: 'quota exceeded',
    });
  });

  it('rejects a 2xx body with no choices', async () => {
    const fake = respondingWith({ body: JSON.stringify({ id: 'x' }) });
    await expect(
      client(fake.transport).complete({ model: 'gpt-4o', messages: [] }),
    ).rejects.toMatchObject({
      code: AI_ERROR_CODE.MalformedResponse,
    });
  });
});

describe('OpenAiCompatibleClient error classification', () => {
  it('classifies a 429 as rate limited and reads Retry-After', async () => {
    const fake = respondingWith({
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '3' : null) },
      body: JSON.stringify({ error: { message: 'rate limit reached' } }),
    });

    const error = await client(fake.transport)
      .complete({ model: 'gpt-4o', messages: [] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe(AI_ERROR_CODE.RateLimited);
    expect((error as AiProviderError).retryAfterMs).toBe(3000);
    expect((error as AiProviderError).retryable).toBe(true);
    expect((error as AiProviderError).failoverable).toBe(true);
  });

  it('classifies a 500 as a provider outage', async () => {
    const fake = respondingWith({ status: 500, body: '' });
    await expect(
      client(fake.transport).complete({ model: 'gpt-4o', messages: [] }),
    ).rejects.toMatchObject({
      code: AI_ERROR_CODE.ProviderUnavailable,
    });
  });

  it('classifies a 400 as a non-retryable, non-failoverable bad request', async () => {
    const fake = respondingWith({
      status: 400,
      body: JSON.stringify({ error: { message: 'bad model' } }),
    });
    await expect(
      client(fake.transport).complete({ model: 'gpt-4o', messages: [] }),
    ).rejects.toMatchObject({
      code: AI_ERROR_CODE.InvalidRequest,
      retryable: false,
      failoverable: false,
    });
  });

  it('wraps a transport failure as a network error', async () => {
    const transport = () => Promise.reject(new TransportNetworkError(new Error('ECONNRESET')));
    const failing = new OpenAiCompatibleClient('OPENAI', { credentials: CREDENTIALS, transport });

    await expect(failing.complete({ model: 'gpt-4o', messages: [] })).rejects.toMatchObject({
      code: AI_ERROR_CODE.NetworkError,
      retryable: true,
      failoverable: true,
    });
  });

  it('reads a provider error message without trusting the body shape', async () => {
    const fake = fakeTransport([
      { status: 400, body: JSON.stringify({ error: 'plain string error' }) },
    ]);
    const error = await client(fake.transport)
      .complete({ model: 'gpt-4o', messages: [] })
      .catch((thrown: unknown) => thrown);

    expect((error as AiProviderError).message).toBe('plain string error');
  });
});
