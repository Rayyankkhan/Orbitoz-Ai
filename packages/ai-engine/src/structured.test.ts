/**
 * Extraction, parsing, and validation of structured output.
 *
 * These are the unhappy paths that reach production: fences, preambles, braces
 * inside strings, truncation. The happy path (a bare document) is one test; the
 * rest are the reasons the module exists.
 */
import { describe, expect, it } from 'vitest';
import { extractJson, parseJson, validateAgainstSchema, type JsonSchema } from './structured.js';

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string', enum: ['a', 'b'] },
  },
  required: ['title', 'count'],
  additionalProperties: false,
};

describe('extractJson', () => {
  it('returns a bare document unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts the last fenced block, because the answer follows the reasoning', () => {
    const text =
      'Let me think.\n```json\n{"example":true}\n```\nHere it is:\n```json\n{"answer":42}\n```';
    expect(extractJson(text)).toBe('{"answer":42}');
  });

  it('extracts JSON from prose with no fence', () => {
    const text = 'Sure, the result is {"answer":42} — hope that helps.';
    expect(extractJson(text)).toBe('{"answer":42}');
  });

  it('ignores braces inside strings while scanning', () => {
    const text = 'Here: {"log":"error } at line 3","ok":true}';
    expect(extractJson(text)).toBe('{"log":"error } at line 3","ok":true}');
  });

  it('handles an escaped backslash before a quote', () => {
    const text = '{"path":"C:\\\\","ok":true}';
    expect(extractJson(text)).toBe('{"path":"C:\\\\","ok":true}');
  });

  it('returns null for truncated output instead of a partial document', () => {
    expect(extractJson('{"title":"half')).toBeNull();
  });

  it('returns null for empty or non-JSON text', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('parseJson', () => {
  it('returns the parsed value or null, never throwing', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('{oops')).toBeNull();
  });
});

describe('validateAgainstSchema', () => {
  it('accepts a conforming document', () => {
    expect(validateAgainstSchema({ title: 'T', count: 2 }, SCHEMA)).toHaveLength(0);
  });

  it('reports every missing required field at once', () => {
    const violations = validateAgainstSchema({}, SCHEMA);
    expect(violations.map((violation) => violation.path).sort()).toEqual(['count', 'title']);
  });

  it('reports a wrong type with the expected and actual kind', () => {
    const violations = validateAgainstSchema({ title: 5, count: 1 }, SCHEMA);
    expect(violations[0]).toMatchObject({
      path: 'title',
      message: expect.stringContaining('must be a string'),
    });
  });

  it('reports a value outside the enum', () => {
    const violations = validateAgainstSchema({ title: 'T', count: 1, mode: 'c' }, SCHEMA);
    expect(violations[0]?.message).toContain('must be one of "a", "b"');
  });

  it('reports a non-integer where an integer is required', () => {
    const violations = validateAgainstSchema({ title: 'T', count: 1.5 }, SCHEMA);
    expect(violations[0]?.path).toBe('count');
  });

  it('validates array items and names the offending index', () => {
    const violations = validateAgainstSchema({ title: 'T', count: 1, tags: ['a', 2] }, SCHEMA);
    expect(violations[0]?.path).toBe('tags[1]');
  });

  it('rejects a field not in the schema when additionalProperties is false', () => {
    const violations = validateAgainstSchema({ title: 'T', count: 1, surprise: true }, SCHEMA);
    expect(violations[0]).toMatchObject({ path: 'surprise', message: 'is not an allowed field' });
  });

  it('accepts an extra field when additionalProperties is not false', () => {
    const open: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(validateAgainstSchema({ a: 'x', b: 'extra' }, open)).toHaveLength(0);
  });

  it('reports a non-object root', () => {
    expect(validateAgainstSchema('nope', SCHEMA)[0]).toMatchObject({
      message: 'must be an object',
    });
  });
});
