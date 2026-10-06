/**
 * The transport contract.
 *
 * Kept deliberately narrow — `fetch` with a `URL`, an `init`, and a parsed
 * response — for three reasons:
 *
 * 1. Tests substitute a function, not a module. A Vitest `vi.mock` of `fetch`
 *    leaks between files and breaks as soon as two modules want different
 *    behaviour; an injected transport is per-test and cannot.
 * 2. Node's `fetch` is undici, whose abort semantics differ subtly from
 *    `AbortSignal.timeout` in test environments. Owning the timeout means the
 *    behaviour under test is the behaviour that ships.
 * 3. A `provider_attempts` row records `latency_ms`, so timing has to be
 *    measured in one place or the column is not comparable between rows.
 */

export interface TransportResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  /** The body, read as text. JSON is parsed above this layer. */
  readonly body: string;
  /** Wall-clock time spent on the request, measured here so every adapter
   *  records the same thing. `provider_attempts.latency_ms` is only comparable
   *  between rows if it is measured in one place. */
  readonly latencyMs: number;
}

export type Transport = (url: string, init: TransportRequest) => Promise<TransportResponse>;

export interface TransportRequest {
  readonly method: 'POST' | 'GET';
  readonly headers: Readonly<Record<string, string>>;
  /** Already serialised. */
  readonly body: string | null;
  readonly signal: AbortSignal;
}

/**
 * A transport backed by the global `fetch`.
 *
 * `fetch` resolves for any HTTP status, including 5xx, so this treats a
 * non-2xx as a normal return and lets the caller classify it. Only a genuine
 * transport failure — DNS, TLS, reset — rejects, and that rejection is wrapped
 * into a `NetworkError` so callers never have to know that undici exists.
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (url, init) => {
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: init.method,
        headers: { ...init.headers },
        body: init.body ?? undefined,
        signal: init.signal,
      });
      const body = await response.text();
      return {
        status: response.status,
        headers: {
          get: (name) => response.headers.get(name),
        },
        body,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw new TransportNetworkError(error);
    }
  };
}

/**
 * A transport-level failure, as opposed to an HTTP error status.
 *
 * A distinct class so the retry layer can tell "the socket broke" from "the
 * server said no" without inspecting error messages — string matching on
 * `ECONNRESET` and friends is how retry policies end up wrong on one platform
 * and right on another.
 */
export class TransportNetworkError extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : `Network request failed: ${String(cause)}`);
    this.name = 'TransportNetworkError';
  }
}

/**
 * Whether a rejection was caused by our own timeout.
 *
 * `AbortSignal.timeout` reports `TimeoutError`, but an undici socket reset
 * surfaces as `AbortError` on the same signal, and those need different handling:
 * the first is our deadline, the second is a peer that hung up. Both are
 * retryable, but only the first should be recorded against the timeout budget.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}
