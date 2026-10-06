/**
 * Extraction, validation, and the exactly-once repair turn.
 *
 * The "once" is the contract: a validation failure triggers one repair, a
 * truncation triggers none, and a second failure is terminal. Each of those is a
 * billing decision, not just a control-flow one.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildRepairPrompt,
  parseStructuredOutput,
  schemaInstructions,
  StructuredOutputError,
  tryParse,
} from './structured.js';
import { AI_ERROR_CODE } from '../errors.js';
import type { JsonSchema } from '../structured.js';

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
};

describe('parseStructuredOutput', () => {
  it('returns a valid first response without repairing', async () => {
    const repair = vi.fn();
    const result = await parseStructuredOutput('{"title":"T"}', SCHEMA, { repair });

    expect(result).toMatchObject({ value: { title: 'T' }, repaired: false, repair: null });
    expect(repair).not.toHaveBeenCalled();
  });

  it('repairs once when the first response violates the schema', async () => {
    const repair = vi.fn(() =>
      Promise.resolve({
        text: '{"title":"fixed"}',
        inputTokens: 7,
        outputTokens: 3,
        costUsdMicros: 40,
      }),
    );
    const result = await parseStructuredOutput('{"nope":1}', SCHEMA, { repair });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(true);
    expect(result.value).toEqual({ title: 'fixed' });
    // The repair's usage is returned so it can be billed like any other call.
    expect(result.repair).toMatchObject({ inputTokens: 7, outputTokens: 3, costUsdMicros: 40 });
  });

  it('does not repair a truncated response; it names the real fix', async () => {
    const repair = vi.fn();
    const error = await parseStructuredOutput('{"title":"half', SCHEMA, { repair }).catch(
      (thrown: unknown) => thrown,
    );

    expect(repair).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).message).toMatch(/max_tokens/);
  });

  it('fails terminally when the repair still violates the schema', async () => {
    const repair = vi.fn(() =>
      Promise.resolve({
        text: '{"still":"wrong"}',
        inputTokens: 1,
        outputTokens: 1,
        costUsdMicros: 1,
      }),
    );
    const error = await parseStructuredOutput('{}', SCHEMA, { repair }).catch(
      (thrown: unknown) => thrown,
    );

    expect(repair).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).message).toMatch(/after one repair/);
  });

  it('repairs output that contains no JSON at all', async () => {
    const repair = vi.fn(() =>
      Promise.resolve({ text: '{"title":"T"}', inputTokens: 1, outputTokens: 1, costUsdMicros: 1 }),
    );
    const result = await parseStructuredOutput('I refuse to answer.', SCHEMA, { repair });

    expect(result.repaired).toBe(true);
  });

  it('is not failoverable: another provider would produce the same malformed text', async () => {
    const error = await parseStructuredOutput('{}', SCHEMA, {
      repair: () =>
        Promise.resolve({ text: '{}', inputTokens: 1, outputTokens: 1, costUsdMicros: 1 }),
    }).catch((thrown: unknown) => thrown);

    expect((error as StructuredOutputError).code).toBe(AI_ERROR_CODE.StructuredOutputInvalid);
    expect((error as StructuredOutputError).failoverable).toBe(false);
  });
});

describe('tryParse', () => {
  it('flags a truncated document as truncated', () => {
    expect(tryParse('{"title":"half', SCHEMA)).toMatchObject({ ok: false, truncated: true });
  });

  it('flags a schema violation as not truncated', () => {
    expect(tryParse('{"title":5}', SCHEMA)).toMatchObject({ ok: false, truncated: false });
  });

  it('accepts a valid document', () => {
    expect(tryParse('{"title":"T"}', SCHEMA)).toEqual({ ok: true, value: { title: 'T' } });
  });
});

describe('repair prompt and instructions', () => {
  it('includes the schema, the named violations, and the original output', () => {
    const prompt = buildRepairPrompt('{"title":5}', SCHEMA, [
      { path: 'title', message: 'must be a string, got a number' },
    ]);

    expect(prompt).toContain('"title"');
    expect(prompt).toContain('title: must be a string, got a number');
    expect(prompt).toContain('{"title":5}');
  });

  it('builds schema instructions for providers without native JSON mode', () => {
    expect(schemaInstructions(SCHEMA)).toContain('Respond with a single JSON document');
  });
});
