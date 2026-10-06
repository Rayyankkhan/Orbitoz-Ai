/**
 * Structured parsing for content-generation responses.
 *
 * A "content generation" node is the commonest thing a tenant builds: ask a
 * model for an article, a product blurb, an email — and then want the title and
 * the body as *separate fields*, because storing a single blob means every
 * downstream consumer re-parses the model's prose to find where the title ended.
 *
 * The schema below is the contract. Everything else in this file exists to make
 * the contract hold when a model ignores it, which it will: a fenced code block,
 * a "Here is your article:" preamble, an empty title when asked for a
 * six-word headline. `parseStructuredOutput` handles extraction and one repair;
 * this file supplies the schema and the semantic checks a JSON-Schema validator
 * cannot express (non-empty strings, de-duplicated tags).
 *
 * The distinction matters for billing. A response that passes JSON validation but
 * has an empty `body` is not a success — it is a call the tenant paid for and
 * cannot use, and it must fail here rather than be stored as a plausible-looking
 * empty document.
 */
import type { JsonSchema } from '../structured.js';
import type { RepairAttempt, RepairOptions } from '../engine/structured.js';
import { parseStructuredOutput, StructuredOutputError } from '../engine/structured.js';

/**
 * The schema sent to providers and used to validate what comes back.
 *
 * `additionalProperties: false` on purpose. A model that invents fields is a
 * model that is guessing at the shape, and silently dropping the guesses hides
 * the fact that the prompt was ambiguous. Reporting them triggers the single
 * repair turn, which is exactly what the repair budget is for.
 */
export const CONTENT_GENERATION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'A short headline for the content, plain text, no markdown.',
    },
    body: {
      type: 'string',
      description: 'The full content body. Preserve the requested format.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentences summarising the content for a list view.',
    },
    tags: {
      type: 'array',
      description: 'Lower-case topic tags, three to eight of them.',
      items: { type: 'string', description: 'A single topic tag.' },
    },
    language: {
      type: 'string',
      description: 'BCP-47 language tag, e.g. "en" or "pt-BR". Omit if unknown.',
    },
  },
  required: ['title', 'body', 'summary', 'tags'],
  additionalProperties: false,
};

/** A validated content-generation result. */
export interface GeneratedContent {
  readonly title: string;
  readonly body: string;
  readonly summary: string;
  /** Trimmed, lower-cased, de-duplicated, empty entries removed. */
  readonly tags: readonly string[];
  /** Null when the model omitted it. */
  readonly language: string | null;
}

export interface ParsedContentGeneration {
  readonly content: GeneratedContent;
  /** True when the first response needed the repair turn. */
  readonly repaired: boolean;
  readonly repair: RepairAttempt | null;
}

/**
 * Extracts, validates, and normalises a content-generation response.
 *
 * @throws {StructuredOutputError} when the output cannot be parsed into the
 *   schema within one repair, or parses but is semantically empty.
 */
export async function parseContentGeneration(
  text: string,
  options: RepairOptions,
): Promise<ParsedContentGeneration> {
  const parsed = await parseStructuredOutput(text, CONTENT_GENERATION_SCHEMA, options);
  const content = normaliseContent(parsed.value, text, options);

  return { content, repaired: parsed.repaired, repair: parsed.repair };
}

/**
 * Narrows the validated document and applies the checks JSON Schema cannot.
 *
 * The document has already passed `validateAgainstSchema`, so every field read
 * below exists and is the right type. The reads are still defensive — a `String`
 * coercion rather than a blind cast — because "the schema ran first" is an
 * invariant that a future change to this file could quietly break, and a crash
 * three call sites later is a worse signal than a well-typed value here.
 */
function normaliseContent(
  value: unknown,
  rawText: string,
  options: RepairOptions,
): GeneratedContent {
  const record = value as Readonly<Record<string, unknown>>;

  const title = String(record.title).trim();
  const body = String(record.body).trim();
  const summary = String(record.summary).trim();
  const language =
    typeof record.language === 'string' && record.language.trim() !== ''
      ? record.language.trim()
      : null;

  const tags = Array.isArray(record.tags)
    ? [
        ...new Set(
          record.tags.map((tag) => String(tag).trim().toLowerCase()).filter((tag) => tag !== ''),
        ),
      ]
    : [];

  // JSON Schema can say "a string"; it cannot say "a non-empty string". An empty
  // title or body is the failure mode a model produces when the prompt was
  // under-specified, and storing it would hand the tenant a result that looks
  // complete and is not. Not repairable: the engine's one repair already ran, and
  // a second call would spend tokens to ask the same model the same question.
  if (title === '' || body === '') {
    throw new StructuredOutputError(
      'Content generation returned an empty title or body, which cannot be stored as a result. ' +
        'Make the prompt explicit about what the content must contain.',
      [
        ...(title === '' ? [{ path: 'title', message: 'must not be empty' }] : []),
        ...(body === '' ? [{ path: 'body', message: 'must not be empty' }] : []),
      ],
      rawText,
      options.provider ?? null,
      options.model ?? null,
    );
  }

  return { title, body, summary, tags, language };
}
