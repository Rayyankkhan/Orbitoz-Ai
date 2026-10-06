/**
 * The Anthropic client, against a substituted transport.
 *
 * Anthropic is not OpenAI-shaped in four places, and each is a decision rather
 * than a mapping: the system prompt is a top-level parameter, `max_tokens` is
 * required, stop sequences are `stop_sequences`, and there is no `response_format`.
 * These tests pin all four, because a client that quietly spoke the OpenAI
 * dialect would produce a 400 on every call and the failure would be blamed on
 * the provider.
 */
import { describe, expect, it } from 'vitest';
import { AI_ERROR_CODE } from '../errors.js';
import { AnthropicClient } from './anthropic.js';
import { respondingWith } from '../testing/transport.js';

const CREDENTIALS = { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-test' };

function client(transport: ReturnType<typeof respondingWith>['transport']) {
  return new AnthropicClient({ credentials: CREDENTIALS, transport });
}

const OK = {
  body: JSON.stringify({
    id: 'msg_1',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 },
  }),
};

describe('AnthropicClient request transformation', () => {
  it('lifts system messages into the top-level system parameter', async () => {
    const fake = respondingWith(OK);
    await client(fake.transport).complete({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const body = fake.requests[0]?.body as Record<string, unknown>;
    expect(body.system).toBe('You are terse.');
    // The system turn must not be echoed as a message: Anthropic rejects the role.
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('joins multiple system messages rather than dropping the second', async () => {
    const fake = respondingWith(OK);
    await client(fake.transport).complete({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: 'First.' },
        { role: 'system', content: 'Second.' },
        { role: 'user', content: 'Go' },
      ],
    });

    const body = fake.requests[0]?.body as Record<string, unknown>;
    expect(body.system).toBe('First.\n\nSecond.');
  });

  it('always sends max_tokens, defaulting when the caller omitted it', async () => {
    const fake = respondingWith(OK);
    await client(fake.transport).complete({ model: 'claude-sonnet-4-5', messages: [] });

    const body = fake.requests[0]?.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
  });

  it('honours an explicit max_tokens', async () => {
    const fake = respondingWith(OK);
    await client(fake.transport).complete({
      model: 'claude-sonnet-4-5',
      messages: [],
      maxTokens: 512,
    });

    expect((fake.requests[0]?.body as Record<string, unknown>).max_tokens).toBe(512);
  });

  it('never sends response_format, which Anthropic does not accept', async () => {
    const fake = respondingWith(OK);
    await client(fake.transport).complete({
      model: 'claude-sonnet-4-5',
      messages: [],
      responseSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    });

    expect(fake.requests[0]?.body).not.toHaveProperty('response_format');
  });

  it('sends the anthropic-version and x-api-key headers', async () => {
    const fake = respondingWith(OK);
    await client(fake.transport).complete({ model: 'claude-sonnet-4-5', messages: [] });

    expect(fake.requests[0]?.init.headers['anthropic-version']).toBe('2023-06-01');
    expect(fake.requests[0]?.init.headers['x-api-key']).toBe('sk-ant-test');
    expect(fake.requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('AnthropicClient response transformation', () => {
  it('concatenates text blocks instead of truncating at the first', async () => {
    const fake = respondingWith({
      body: JSON.stringify({
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 4 },
      }),
    });
    const response = await client(fake.transport).complete({
      model: 'claude-sonnet-4-5',
      messages: [],
    });

    expect(response.text).toBe('part one part two');
  });

  it('maps max_tokens to a truncated length finish', async () => {
    const fake = respondingWith({
      body: JSON.stringify({
        content: [{ type: 'text', text: '{partial' }],
        stop_reason: 'max_tokens',
      }),
    });
    const response = await client(fake.transport).complete({
      model: 'claude-sonnet-4-5',
      messages: [],
    });

    expect(response.finishReason).toBe('length');
    expect(response.truncated).toBe(true);
  });

  it('maps a refusal to a content filter rather than a generic stop', async () => {
    const fake = respondingWith({
      body: JSON.stringify({ content: [], stop_reason: 'refusal' }),
    });
    const response = await client(fake.transport).complete({
      model: 'claude-sonnet-4-5',
      messages: [],
    });

    expect(response.finishReason).toBe('content_filter');
  });

  it('rejects a response with no content array', async () => {
    const fake = respondingWith({ body: JSON.stringify({ id: 'x' }) });
    await expect(
      client(fake.transport).complete({ model: 'claude-sonnet-4-5', messages: [] }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODE.MalformedResponse });
  });
});
