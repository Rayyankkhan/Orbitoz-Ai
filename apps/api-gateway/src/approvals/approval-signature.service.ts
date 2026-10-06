/**
 * Signing and verification of approval decision grants.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ACTUALLY PROTECTS
 * ---------------------------------------------------------------------------
 * Not the approver. The approver is a person who clicked a link, and there is no
 * client-side secret involved — see the note in `@orbitoz/shared-types` about why
 * the signature is issued rather than computed by the browser.
 *
 * What it protects is the *link*: it binds one signature to one approval request,
 * one action and a short window. Without it, anyone who could edit the page —
 * a caching proxy, a mail client rewriting a URL, an XSS foothold — could change
 * `action: "APPROVE"` to `action: "REJECT"` and kill a production workflow, or
 * replay a captured grant forever. Signing the action makes the second attack
 * need a fresh signature, and signing the timestamp bounds the first.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPARISON IS TIMING-SAFE AND THE OTHER CHECKS ARE NOT
 * ---------------------------------------------------------------------------
 * The MAC is compared with `timingSafeEqual`, because it is a secret-dependent
 * value and a byte-by-byte early-exit comparison leaks its prefix. Everything
 * else — the timestamp window, the expiry, the action name — is compared against
 * values the caller already knows, so there is nothing to leak and an early exit
 * saves nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE SECRET FROM THE JWT KEYS
 * ---------------------------------------------------------------------------
 * An approval signature and an access token are different kinds of thing with
 * different blast radii, and one is verified by a route no session can reach.
 * Sharing a key would mean a signature minted for an approval link could be
 * presented as a bearer token for anything that accepts the JWT scheme, which
 * defeats the separation `env.ts` already enforces between the two JWT secrets.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  APPROVAL_SIGNATURE_VERSION,
  approvalSigningPayload,
  formatApprovalSignature,
  parseApprovalSignature,
  type ApprovalAction,
} from '@orbitoz/shared-types';

export interface ApprovalSignatureConfig {
  /** The HMAC key. Enforced to be at least 32 bytes, as `env.ts` enforces for the JWT secrets. */
  readonly secret: string;
  /** How far a grant's timestamp may be from now, in seconds. */
  readonly toleranceSeconds: number;
}

/** HMAC-SHA256, matching the `v1` marker in the wire format. */
const ALGORITHM = 'sha256';

/** Minimum key length. See the module comment and `env.ts`. */
const MIN_SECRET_BYTES = 32;

// A timestamp is a Unix second count: digits only.
//
// Deliberately a regex rather than `Number.isInteger(Number(x))`, because the
// numeric version accepts things this field must not. `Number('')` is 0, so an
// empty timestamp would pass the integer check and be compared as the epoch —
// correct-looking code that quietly reads a missing field as 1970. `'1.5'`,
// `' 12'` and `'1e3'` are all numbers too, and none of them is a second count.
const UNIX_SECONDS = /^\d{1,20}$/;

export type SignatureRejection =
  | 'malformed'
  | 'unsupported_version'
  | 'mismatch'
  | 'timestamp_out_of_range'
  | 'timestamp_not_integer';

export type SignatureVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureRejection };

export class ApprovalSignatureService {
  private readonly secret: string;
  private readonly toleranceSeconds: number;

  constructor(config: ApprovalSignatureConfig) {
    if (Buffer.byteLength(config.secret, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error(
        `Approval signature secret must be at least ${MIN_SECRET_BYTES} bytes. A short HMAC key ` +
          'produces signatures that verify, so a truncated secret is indistinguishable from a ' +
          'working one until someone forges with it.',
      );
    }
    this.secret = config.secret;
    this.toleranceSeconds = config.toleranceSeconds;
  }

  /**
   * Mints the grant for one action on one approval.
   *
   * Both actions are signed at view time so the rendered page needs no
   * JavaScript: the approver's browser cannot compute an HMAC, so the server
   * hands it a pre-signed pair and the click simply posts it back.
   */
  sign(token: string, action: ApprovalAction, timestampSeconds: number): string {
    return formatApprovalSignature(this.mac(token, action, timestampSeconds));
  }

  /**
   * Verifies a presented grant.
   *
   * Returns a reason rather than throwing: every caller wants to map a failure
   * onto either a 401 or a 410, and a thrown error would make that mapping a
   * catch block instead of a switch.
   *
   * `nowSeconds` is injected so the window is testable without freezing time.
   */
  verify(
    token: string,
    action: ApprovalAction,
    presentedTimestamp: string,
    presentedSignature: unknown,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): SignatureVerification {
    const parsed = parseApprovalSignature(presentedSignature);
    if (!parsed.ok) {
      return { ok: false, reason: 'malformed' };
    }
    // Shape was validated by the parser; the *policy* is ours. Keeping them apart
    // is what lets an unknown scheme be reported as unsupported rather than
    // folded into "malformed", which a caller cannot act on.
    if (parsed.parsed.version !== APPROVAL_SIGNATURE_VERSION) {
      return { ok: false, reason: 'unsupported_version' };
    }

    const timestampSeconds = Number(presentedTimestamp);
    if (typeof presentedTimestamp !== 'string' || !UNIX_SECONDS.test(presentedTimestamp)) {
      return { ok: false, reason: 'timestamp_not_integer' };
    }
    // Absolute difference, so a clock behind ours is bounded exactly like a clock
    // ahead of it. `Math.abs(now - issued) > tolerance` rather than a two-sided
    // range check, which would be the same rule written twice.
    if (Math.abs(nowSeconds - timestampSeconds) > this.toleranceSeconds) {
      return { ok: false, reason: 'timestamp_out_of_range' };
    }

    // The MAC is computed *before* the range check would let the caller claim a
    // timestamp the issuer never used: the string re-signed here is the one that
    // binds the timestamp, so a caller cannot widen the window by lying about it.
    const expected = Buffer.from(this.mac(token, action, timestampSeconds), 'hex');
    const presented = Buffer.from(parsed.parsed.macHex, 'hex');

    // Both are 32 bytes for any accepted input — `parseApprovalSignature` has
    // already enforced exactly 64 hex characters — so the lengths match and
    // `timingSafeEqual` cannot throw.
    return timingSafeEqual(expected, presented) ? { ok: true } : { ok: false, reason: 'mismatch' };
  }

  /** The hex HMAC over the canonical string for one token/action/timestamp. */
  private mac(token: string, action: ApprovalAction, timestampSeconds: number): string {
    return createHmac(ALGORITHM, this.secret)
      .update(approvalSigningPayload(token, action, timestampSeconds), 'utf8')
      .digest('hex');
  }

  /** The configured tolerance. Surfaced so a handler can explain a 401. */
  get tolerance(): number {
    return this.toleranceSeconds;
  }
}
