/**
 * The content-generation parser.
 *
 * The schema is the easy part. These tests focus on the two failure modes that
 * matter in production: a model that wraps its JSON in prose (the parser must
 * still find it) and a model that returns structurally valid but semantically
 * empty content (an empty body must fail, not be stored).
 */
import { describe, expect, it, vi } from 'vitest';
import { CONTENT_GENERATION_SCHEMA, parseContentGeneration } from './content.js';
import type { RepairOptions } from '../engine/structured.js';

const VALID = JSON.stringify({
  title: 'Widgets in 2026',
  body: 'Widgets are back.',
  summary: 'A short roundup.',
  tags: ['Widgets', ' widgets ', 'Industry'],
});

/** A repair callback that must never be called in the success-path tests. */
const NO_REPAIR: RepairOptions = {
  repair: () => Promise.reject(new Error('repair should not have been called')),
};

describe('parseContentGeneration', () => {
  it('parses a bare JSON document and normalises tags', async () => {
    const result = await parseContentGeneration(VALID, NO_REPAIR);

    expect(result.repaired).toBe(false);
    expect(result.content).toEqual({
      title: 'Widgets in 2026',
      body: 'Widgets are back.',
      summary: 'A short roundup.',
      tags: ['widgets', 'industry'],
      language: null,
    });
  });

  it('extracts JSON from a fenced code block with a preamble', async () => {
    const raw = `Sure! Here is the content:\n\n\`\`\`json\n${VALID}\n\`\`\``;
    const result = await parseContentGeneration(raw, NO_REPAIR);

    expect(result.content.title).toBe('Widgets in 2026');
  });

  it('repairs once when the first response does not match the schema', async () => {
    const repair = vi.fn(() =>
      Promise.resolve({
        text: VALID,
        inputTokens: 4,
        outputTokens: 8,
        costUsdMicros: 12,
      }),
    );

    const result = await parseContentGeneration('{"title": "only a title"}', { repair });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(true);
    expect(result.repair).toMatchObject({ inputTokens: 4, outputTokens: 8, costUsdMicros: 12 });
    expect(result.content.title).toBe('Widgets in 2026');
  });

  it('rejects an empty body even though it is a valid string', async () => {
    // JSON Schema cannot say "non-empty", and an empty body is the exact result a
    // tenant cannot use while the job still looks successful.
    const raw = JSON.stringify({ title: 'T', body: '   ', summary: 's', tags: [] });

    await expect(
      parseContentGeneration(raw, { repair: () => Promise.reject(new Error('unreachable')) }),
    ).rejects.toThrow(/empty title or body/);
  });

  it('rejects an unknown field, which is a signal the prompt was ambiguous', async () => {
    const raw = JSON.stringify({
      title: 'T',
      body: 'B',
      summary: 's',
      tags: [],
      seoKeywords: ['x'],
    });

    await expect(
      parseContentGeneration(raw, { repair: () => Promise.reject(new Error('unreachable')) }),
    ).rejects.toThrow();
  });

  it('describes the schema with every field the prompt must produce', () => {
    expect(CONTENT_GENERATION_SCHEMA.required).toEqual(['title', 'body', 'summary', 'tags']);
    expect(CONTENT_GENERATION_SCHEMA.additionalProperties).toBe(false);
  });
});
