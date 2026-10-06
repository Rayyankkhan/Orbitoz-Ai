/**
 * Structured output extraction, validation, and one repair attempt.
 *
 * The industry reflex is to ask for JSON and hope. That works until it does not,
 * and when it does not the failure is the worst kind: the job succeeded, the
 * tenant got `null`, and nobody can tell whether the model refused or the parser
 * was wrong.
 *
 * So: extract defensively, validate strictly, and **repair exactly once**.
 *
 * The "once" is load-bearing. A repair loop is easy to write and it burns money on
 * every iteration while making the failure harder to diagnose, because a model that
 * cannot produce valid JSON after four increasingly detailed prompts will not
 * produce it after five. One repair turns a parse failure into either a usable
 * result or a specific, quoted error the caller can act on.
 */
import { AiProviderError, AI_ERROR_CODE } from '../errors.js';
import {
  extractJson,
  isTruncatedJson,
  parseJson,
  validateAgainstSchema,
  type JsonSchema,
  type SchemaViolation,
} from '../structured.js';
import type { ChatMessage } from '../providers/contracts.js';

/** How a schema failure is described back to the model. */
export interface RepairAttempt {
  /** The model that produced the bad output. */
  readonly model: string;
  /** The repair call's own usage, so a repair is billed rather than free. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsdMicros: number;
}

export interface StructuredParseResult {
  readonly value: unknown;
  /** True when the first output needed the repair turn. */
  readonly repaired: boolean;
  readonly repair: RepairAttempt | null;
}

export class StructuredOutputError extends AiProviderError {
  readonly violations: readonly SchemaViolation[];
  /** The text that failed, truncated. Quoted so the tenant can see what came back. */
  readonly rawText: string;

  constructor(
    message: string,
    violations: readonly SchemaViolation[],
    rawText: string,
    provider: string | null = null,
    model: string | null = null,
  ) {
    super({
      code: AI_ERROR_CODE.StructuredOutputInvalid,
      message,
      ...(provider === null ? {} : { provider }),
      ...(model === null ? {} : { model }),
      // Never failoverable: the prompt produced unparseable text, and a different
      // provider would very likely produce the same kind of text. Spending another
      // provider's tokens on the same malformed input is not a fallback, it is a
      // second bill for one failed answer.
      failoverable: false,
    });
    this.name = 'StructuredOutputError';
    this.violations = violations;
    this.rawText = rawText;
  }
}

/** Output text is truncated before being quoted in an error or a repair prompt. */
export const MAX_QUOTED_TEXT = 2_000;

function truncate(text: string): string {
  return text.length <= MAX_QUOTED_TEXT
    ? text
    : `${text.slice(0, MAX_QUOTED_TEXT)}… (${text.length - MAX_QUOTED_TEXT} more characters)`;
}

export interface ParseOptions {
  readonly provider?: string | null;
  readonly model?: string | null;
}

export interface RepairOptions extends ParseOptions {
  /**
   * Issues the repair call. Supplied by the caller so this module has no provider
   * dependency — the repair prompt is provider-agnostic, and injecting the caller
   * keeps it that way.
   */
  readonly repair: (messages: readonly ChatMessage[]) => Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsdMicros: number;
  }>;
}

/**
 * Extracts and validates model output against a schema, repairing once if needed.
 *
 * Three distinct failures, reported differently because they need different fixes:
 *
 * | Failure | Cause | Fix |
 * | --- | --- | --- |
 * | no JSON in the text | prose around the document | repair |
 * | JSON that does not parse | truncated at `max_tokens` | raise `max_tokens` |
 * | JSON that violates the schema | wrong shape | repair |
 *
 * Truncation is called out separately because the repair prompt cannot fix it: the
 * model was cut off mid-document and a re-prompt that includes the partial document
 * usually reproduces the same truncation. Raising `maxTokens` is the actual fix,
 * and an error that says so saves the tenant a wasted repair call.
 */
export async function parseStructuredOutput(
  text: string,
  schema: JsonSchema,
  options: RepairOptions,
): Promise<StructuredParseResult> {
  const first = tryParse(text, schema);

  if (first.ok) {
    return { value: first.value, repaired: false, repair: null };
  }

  if (first.truncated) {
    // Not repairable. Attempting it would spend a call to reproduce the same
    // truncation, and would report the failure as a schema violation when the
    // actual cause is a token limit the caller controls.
    throw new StructuredOutputError(
      'Model output was cut off mid-document (the provider stopped at max_tokens), so it ' +
        'cannot be repaired. Increase max_tokens for this node.',
      first.violations,
      truncate(text),
      options.provider ?? null,
      options.model ?? null,
    );
  }

  const repair = await options.repair([
    { role: 'user', content: text },
    {
      role: 'assistant',
      content: 'I could not produce output matching the required schema.',
    },
    { role: 'user', content: buildRepairPrompt(text, schema, first.violations) },
  ]);

  const second = tryParse(repair.text, schema);

  if (!second.ok) {
    throw new StructuredOutputError(
      `Model output did not match the schema after one repair attempt. ` +
        `Violations: ${formatViolations(second.violations)}. ` +
        `Original output: ${truncate(text)}. ` +
        `Repair output: ${truncate(repair.text)}`,
      second.violations,
      truncate(repair.text),
      options.provider ?? null,
      options.model ?? null,
    );
  }

  return {
    value: second.value,
    repaired: true,
    repair: {
      model: options.model ?? 'unknown',
      inputTokens: repair.inputTokens,
      outputTokens: repair.outputTokens,
      costUsdMicros: repair.costUsdMicros,
    },
  };
}

type ParseOutcome =
  | { ok: true; value: unknown }
  | { ok: false; violations: readonly SchemaViolation[]; truncated: boolean };

/**
 * One parse attempt. Never throws.
 *
 * Returning a discriminated result rather than throwing keeps the "try, and on
 * failure decide whether repair is even possible" logic in one readable sequence
 * instead of a try/catch ladder where each catch re-checks the failure reason.
 */
export function tryParse(text: string, schema: JsonSchema): ParseOutcome {
  const candidate = extractJson(text);
  if (candidate === null) {
    // A document that never balanced is a truncation, not prose. Reporting it as
    // "no JSON found" would send it to the repair turn, which re-runs the same
    // generation and hits the same `max_tokens` wall.
    const truncated = isTruncatedJson(text);
    return {
      ok: false,
      truncated,
      violations: [
        {
          path: '$',
          message: truncated
            ? 'JSON is truncated: the document ends mid-value, which is what a max_tokens cut-off looks like'
            : 'no JSON document found in the output',
        },
      ],
    };
  }

  const parsed = parseJson(candidate);
  if (parsed === null) {
    // An extracted fragment that will not parse is almost always a truncated
    // document: `extractJson` balances braces and found a *plausible* prefix.
    const looksTruncated = !candidate.trimEnd().endsWith('}');
    return {
      ok: false,
      truncated: looksTruncated,
      violations: [
        {
          path: '$',
          message: looksTruncated
            ? 'JSON is truncated: the document ends mid-value, which is what a max_tokens cut-off looks like'
            : 'extracted JSON did not parse',
        },
      ],
    };
  }

  const violations = validateAgainstSchema(parsed, schema);
  if (violations.length > 0) {
    // A structurally valid document that violates the schema is not truncation,
    // whatever its final character: the repair prompt can act on it.
    return { ok: false, truncated: false, violations };
  }

  return { ok: true, value: parsed };
}

/**
 * Builds the repair prompt.
 *
 * Includes the schema, the specific violations, and the original output. Including
 * the violations — rather than just "please fix it" — is what makes the repair
 * usually work: the model is correcting a named field rather than guessing at an
 * unstated requirement.
 */
export function buildRepairPrompt(
  text: string,
  schema: JsonSchema,
  violations: readonly SchemaViolation[],
): string {
  return [
    'Your previous response could not be parsed.',
    '',
    'Required JSON schema:',
    JSON.stringify(schema, null, 2),
    '',
    'Problems found:',
    ...violations.map((violation) => `- ${violation.path}: ${violation.message}`),
    '',
    'Your previous response:',
    '```',
    truncate(text),
    '```',
    '',
    'Return only the corrected JSON document. No prose, no explanation, no markdown fences.',
  ].join('\n');
}

export function formatViolations(violations: readonly SchemaViolation[]): string {
  if (violations.length === 0) return 'none';
  return violations.map((violation) => `${violation.path} ${violation.message}`).join('; ');
}

/** Builds the schema instructions for providers with no native JSON mode. */
export function schemaInstructions(schema: JsonSchema): string {
  return [
    'Respond with a single JSON document and nothing else.',
    'Do not wrap it in markdown fences and do not add any commentary.',
    'The document must conform to this JSON schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}
