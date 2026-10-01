/**
 * Explicit success/failure union instead of throwing.
 *
 * The B2B integration surface (webhooks, provider adapters, queue processors)
 * has a lot of expected failure. Encoding expected failure in the return type
 * means the compiler forces the caller to handle it, which is what keeps an
 * upstream provider timeout from turning into an unhandled rejection.
 */
export type Result<T, E = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/** Unwraps or throws. For use at the boundary of an already-checked Result. */
export function unwrapOrThrow<T, E>(result: Result<T, E>, message?: string): T {
  if (result.ok) return result.value;
  const reason =
    message ?? (result.error instanceof Error ? result.error.message : 'unwrap failed');
  throw result.error instanceof Error ? result.error : new Error(reason);
}

export async function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Promise<U> | U,
): Promise<Result<U, E>> {
  return result.ok ? Ok(await fn(result.value)) : result;
}
