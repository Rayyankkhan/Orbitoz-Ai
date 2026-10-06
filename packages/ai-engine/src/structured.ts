/**
 * Structured output.
 *
 * Asking a model for JSON does not produce JSON. It produces JSON *usually* —
 * wrapped in a fence, prefixed with "Here's the JSON:", truncated at the token
 * limit, or with a trailing comma because the text was cut off mid-object. The
 * happy path is the easy part; everything here exists because the unhappy paths
 * are the ones that reach production.
 *
 * Three layers, in order:
 *
 *  1. **Extract.** Get a candidate JSON document out of whatever prose the model
 *     wrapped it in.
 *  2. **Validate** against a schema the caller supplies.
 *  3. **Repair once.** If validation failed, re-ask with the specific complaint
 *     attached. Exactly once — a repair loop turns a bad prompt into an unbounded
 *     token bill and still fails when the real problem is the schema.
 *
 * The one-shot limit is the important design decision. Two repairs would be
 * marginally more successful on flaky models and unboundedly expensive on a
 * systematically wrong prompt; the failure surfaces as a clear error naming the
 * validation problems, which is actionable, instead of a job that spends forty
 * seconds and still fails.
 */

/** A minimal JSON-Schema subset. Providers accept this shape directly. */
export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export type JsonSchemaProperty =
  | { readonly type: 'string'; readonly description?: string; readonly enum?: readonly string[] }
  | { readonly type: 'number'; readonly description?: string }
  | { readonly type: 'integer'; readonly description?: string }
  | { readonly type: 'boolean'; readonly description?: string }
  | { readonly type: 'array'; readonly description?: string; readonly items?: JsonSchemaProperty }
  | {
      readonly type: 'object';
      readonly description?: string;
      readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
      readonly required?: readonly string[];
    }
  | { readonly type: 'null'; readonly description?: string };

/** A single schema violation, phrased so it can be shown to a model verbatim. */
export interface SchemaViolation {
  readonly path: string;
  readonly message: string;
}

/**
 * Pulls a JSON document out of model text.
 *
 * Handles, in order of how often they occur:
 *
 * - a bare document
 * - a fenced block, ```json or bare ```
 * - a fenced block that is the *last* one, when the model explained itself first
 * - prose before or after the document
 *
 * Fence extraction is tried before brace-scanning because a fence is unambiguous.
 * A document inside a fence is bounded by the fence; without one, the right
 * boundaries are inferred, and a model that writes `{...}` twice for two
 * different reasons should not have its first example silently chosen.
 *
 * Returns null when nothing parses, so the caller can decide between repairing
 * and failing — this function has no opinion on which.
 */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // Already a bare document.
  if (isCompleteJson(trimmed)) return trimmed;

  // Fenced blocks, last one first: when a model reasons in a fence and then
  // answers in a second fence, the answer is the later one.
  const fences = [...trimmed.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const candidate = fences[i]?.[1]?.trim();
    if (candidate !== undefined && isCompleteJson(candidate)) return candidate;
  }

  // Prose-wrapped: scan for the first balanced object or array.
  return scanForBalancedJson(trimmed);
}

/**
 * Whether the text looks like a JSON document cut off mid-value.
 *
 * `extractJson` returns null for both "no JSON here" and "JSON that never
 * balanced", and those need opposite handling: prose is worth a repair turn, a
 * truncated document is not — the model was cut off by `max_tokens` and a repair
 * call reproduces the same truncation. This distinguishes them by scanning for a
 * structural opener whose brackets never close, or that ends inside a string.
 */
export function isTruncatedJson(text: string): boolean {
  const start = findFirstStructuralChar(text);
  if (start === -1) return false;

  const open = text[start];
  if (open !== '{' && open !== '[') return false;

  const stack: string[] = [open === '{' ? '}' : ']'];
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      const expected = stack.pop();
      if (expected !== char) return false; // Mismatched: malformed, not a cut-off.
      if (stack.length === 0) return false; // Balanced: not truncated.
    }
  }

  // Reached the end with an open bracket or inside a string: the document was
  // cut off before it could close.
  return stack.length > 0 || inString;
}

/** Parses `text` as JSON, or returns null. Never throws. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * True when the text is a single complete JSON value.
 *
 * Rejects strings that merely *start* like JSON. `"Sure! {"` is not valid JSON,
 * and `JSON.parse` throwing on it is correct behaviour, not a bug to route
 * around.
 */
function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the first balanced `{...}` or `[...]` region, ignoring braces inside
 * strings.
 *
 * String-awareness is the whole difficulty. A model summarising a log line
 * containing `}` would truncate the document at that brace if this counted
 * characters; a JSON document with an escaped quote inside a value would run
 * past its end. Both produce a parse error on text that was perfectly good.
 */
function scanForBalancedJson(text: string): string | null {
  const start = findFirstStructuralChar(text);
  if (start === -1) return null;

  const open = text[start];
  if (open !== '{' && open !== '[') return null;

  const stack: string[] = [open === '{' ? '}' : ']'];
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      // A backslash escapes the next character *inside* a string, including
      // another backslash. Tracking this two-character state is what keeps
      // `"a\\"` from ending the string early.
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      const expected = stack.pop();
      if (expected !== char) return null; // Mismatched: malformed, not nested.
      if (stack.length === 0) {
        const candidate = text.slice(start, i + 1);
        return isCompleteJson(candidate) ? candidate : null;
      }
    }
  }

  // Unbalanced at the end — the classic truncated-output case.
  return null;
}

function findFirstStructuralChar(text: string): number {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') return i;
  }
  return -1;
}

/**
 * Validates a parsed value against the supported JSON-Schema subset.
 *
 * Hand-written rather than delegating to a schema library, because the subset is
 * small and the failure messages need to be model-readable — a generic validator
 * reports `$root.results[2]` and the repair prompt is useless. This reports
 * `results[2]` and names the expected type.
 *
 * Collects *all* violations rather than failing on the first. A model repairing
 * against "field A is wrong" when A, B and C are all wrong will fix A, fail
 * again, fix B, and fail again — three calls to correct one mistake.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = '$',
): readonly SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  if (!isPlainObject(value)) {
    violations.push({ path: displayPath(path), message: 'must be an object' });
    return violations;
  }

  const record = value;
  const required = schema.required ?? [];

  for (const key of required) {
    if (!(key in record) || record[key] === undefined) {
      violations.push({
        path: displayPath(path === '$' ? key : `${path}.${key}`),
        message: 'is required',
      });
    }
  }

  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    const present = record[key];
    if (present === undefined) {
      // Not required, so absence is fine.
      if (!required.includes(key)) continue;
      continue; // Already reported above as missing.
    }
    violations.push(...validateProperty(present, propertySchema, `${path}.${key}`));
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in schema.properties)) {
        violations.push({
          path: displayPath(path === '$' ? key : `${path}.${key}`),
          message: 'is not an allowed field',
        });
      }
    }
  }

  return violations;
}

function validateProperty(
  value: unknown,
  schema: JsonSchemaProperty,
  path: string,
): readonly SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  const shown = displayPath(path);

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        violations.push({ path: shown, message: `must be a string, got ${describeType(value)}` });
        break;
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        violations.push({
          path: shown,
          message: `must be one of ${schema.enum.map((v) => `"${v}"`).join(', ')}`,
        });
      }
      break;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        violations.push({ path: shown, message: `must be a number, got ${describeType(value)}` });
      }
      break;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        violations.push({
          path: shown,
          message: `must be a whole number, got ${describeType(value)}`,
        });
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        violations.push({
          path: shown,
          message: `must be true or false, got ${describeType(value)}`,
        });
      }
      break;
    }
    case 'null': {
      if (value !== null) {
        violations.push({ path: shown, message: 'must be null' });
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push({ path: shown, message: `must be an array, got ${describeType(value)}` });
        break;
      }
      const items = schema.items;
      if (items !== undefined) {
        // Bound to a local rather than asserted: the `!` would be a claim the
        // compiler cannot verify across the closure, and a future change that
        // widens `items` would turn it into a runtime `undefined` dereference.
        value.forEach((item, index) => {
          // Bracketed so an array element is distinguishable from an object field
          // named with a digit: `results[2]` reads as an index, `results.2` does
          // not, and the repair prompt shows this path to the model verbatim.
          violations.push(...validateProperty(item, items, `${path}[${index}]`));
        });
      }
      break;
    }
    case 'object': {
      if (!isPlainObject(value)) {
        violations.push({ path: shown, message: `must be an object, got ${describeType(value)}` });
        break;
      }
      if (schema.properties !== undefined || schema.required !== undefined) {
        const nested: JsonSchema = {
          type: 'object',
          properties: schema.properties ?? {},
          ...(schema.required !== undefined ? { required: schema.required } : {}),
        };
        violations.push(...validateAgainstSchema(value, nested, path));
      }
      break;
    }
  }

  return violations;
}

/**
 * The `$`-rooted prefix is noise in a message a model reads.
 *
 * `$.summary` becomes `summary`; nested paths keep their full form, so
 * `results[2].score` is still unambiguous about which element is wrong.
 */
function displayPath(path: string): string {
  return path.startsWith('$.') ? path.slice(2) : path === '$' ? 'the document' : path;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    // Enumerated so the lint's exhaustiveness check is satisfied; the default is
    // still required because TypeScript does not treat a `typeof` switch as
    // exhaustive even when every branch is present. These four are not JSON
    // types, so reaching one means a caller passed something unexpected.
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      return typeof value;
    default:
      return typeof value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
