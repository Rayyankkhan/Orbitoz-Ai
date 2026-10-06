/**
 * Prompt templates.
 *
 * The interpolation syntax is `{{path.to.value}}`, resolved against a plain
 * object. Chosen over alternatives for one reason: **a missing variable is an
 * error, not an empty string.**
 *
 * The failure this prevents is specific and expensive. A prompt template reading
 * "Summarise {{customer.name}}'s invoice" that silently renders "Summarise 's
 * invoice" produces a *plausible* summary of the wrong document, the tenant has
 * no way to tell it is wrong, and nobody finds out until a customer complains
 * about a summary that ignored their name. An empty string fails the same way. A
 * thrown error fails immediately, at the node that declared the dependency,
 * before a single token is spent.
 *
 * So: strict by default, with an explicit opt-in for optional variables. There is
 * no "missing variables render as empty" mode, because that mode is what caused
 * the problem.
 */

/** Values a template may interpolate. JSON-ish; no functions, no cycles. */
export type TemplateScope = Readonly<Record<string, unknown>>;

/** `{{ name }}` or `{{ a.b.c }}`. Whitespace inside the braces is allowed. */
const PLACEHOLDER = /\{\{\s*([\w$.-]+)\s*\}\}/g;

export class PromptTemplateError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = 'PromptTemplateError';
  }
}

/**
 * Reads a dotted path out of a scope.
 *
 * `noUncheckedIndexedAccess` means every intermediate hop is `| undefined`, and
 * this returns `undefined` rather than throwing — the caller decides whether a
 * missing value is fatal. Array indices are supported (`items.0.id`) because
 * workflow loops produce arrays and a template that cannot reach into one is
 * useless in exactly the place it is most needed.
 */
export function resolvePath(scope: TemplateScope, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = scope;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      // Only numeric segments index an array. `items.length` is deliberately not
      // special-cased: a template that needs a length needs an explicit count, and
      // silently supporting `.length` on arrays but not objects is the kind of
      // asymmetry that produces different templates rendering differently.
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }

    if (typeof current !== 'object') return undefined;
    // A prototype-polluting path (`__proto__.constructor`) is refused rather than
    // resolved. Template text can come from a tenant-authored workflow, so this
    // is reachable input, not a hypothetical.
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Renders a string, interpolating or omitting variables named in `optionalPaths`.
 *
 * @param template the template text.
 * @param scope values available for interpolation.
 * @param optionalPaths paths that may be absent. They render as an empty string.
 * @throws {PromptTemplateError} when a required path is missing.
 */
export interface PromptOptions {
  /** Paths that may be absent. An unresolved optional path renders as empty. */
  readonly optionalPaths?: readonly string[];
}

export function renderPrompt(
  template: string,
  scope: TemplateScope,
  options: PromptOptions = {},
): string {
  const optional = new Set(options.optionalPaths ?? []);
  const missing: string[] = [];

  const rendered = template.replace(PLACEHOLDER, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const value = resolvePath(scope, path);

    if (value === undefined || value === null) {
      if (optional.has(path)) return '';
      missing.push(path);
      return '';
    }

    return stringify(value);
  });

  if (missing.length > 0) {
    // Sorted and de-duplicated: a template with the same variable in three
    // sentences should report one problem, not three identical ones.
    const unique = [...new Set(missing)].sort();
    throw new PromptTemplateError(
      `Prompt template references ${unique.length} undefined value(s): ${unique.join(', ')}. ` +
        'Declare them as optional only if the prompt reads correctly without them.',
      unique[0] ?? '<unknown>',
    );
  }

  return rendered;
}

/**
 * Renders a non-string value for interpolation.
 *
 * Objects and arrays become JSON rather than `[object Object]`. A template that
 * interpolates a whole object — a tool result, a previous node's output — is a
 * normal thing to want, and `[object Object]` would send that to the provider as
 * literal text.
 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

/** Every path a template references, in order of first appearance. */
export function referencedPaths(template: string): readonly string[] {
  const paths: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const path = match[1];
    if (path !== undefined) paths.push(path.trim());
  }
  return [...new Set(paths)];
}

/**
 * Renders every string field in a flat record of templates.
 *
 * Used for system prompts and per-node templates, where a workflow definition is
 * a bag of strings and validating each one independently would be the same code
 * three times.
 */
export function renderPromptMap(
  templates: Readonly<Record<string, string>>,
  scope: TemplateScope,
  options: { readonly optionalPaths?: readonly string[] } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(templates)) {
    out[key] = renderPrompt(template, scope, options);
  }
  return out;
}
