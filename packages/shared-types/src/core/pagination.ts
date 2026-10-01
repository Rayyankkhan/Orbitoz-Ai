/**
 * Opaque cursor codec for keyset pagination.
 *
 * Deliberately hand-rolled rather than pulled from a dependency:
 *
 *  - cursors are part of the public API contract, so the encoding must stay
 *    stable across releases. Bumping `CURSOR_VERSION` invalidates old cursors,
 *    which is the intended, safe behaviour.
 *  - this package is imported by browser code as well as services, so it
 *    cannot depend on `Buffer` or any Node builtin.
 */

const CURSOR_VERSION = 1;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface CursorPayload {
  /** Unique, monotonically sortable value of the last row on the page. */
  readonly v: string;
  /** Tiebreaker for rows sharing `v` (e.g. `createdAt`). */
  readonly i: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...payload, n: CURSOR_VERSION }));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;

    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    // The last group is short; pad with the alphabet's neutral element.
    out += i + 1 < bytes.length ? BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '';
    out += i + 2 < bytes.length ? BASE64URL_ALPHABET[b2 & 0x3f] : '';
  }
  return out;
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const bytes = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(cursor));
    const parsed: unknown = JSON.parse(bytes);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { v, i, n } = parsed as { v?: unknown; i?: unknown; n?: unknown };
    if (n !== CURSOR_VERSION) return null;
    if (typeof v !== 'string' || typeof i !== 'string') return null;

    return { v, i };
  } catch {
    // A malformed cursor is a client error, not a server crash.
    return null;
  }
}

function base64UrlToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let index = 0;

  for (const char of clean) {
    const value = BASE64URL_ALPHABET.indexOf(char);
    if (value === -1) throw new Error('invalid base64url character');
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Clamps an untrusted `limit` into a sane range. */
export function clampLimit(limit: number | undefined, fallback = 25, max = 100): number {
  if (limit === undefined || Number.isNaN(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}
