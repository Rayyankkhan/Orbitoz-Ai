/**
 * The approval link protocol: how an approval request is addressed, and how one
 * decision on it is authorised.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CANONICAL STRING LIVES HERE AND NOT IN THE SERVICE
 * ---------------------------------------------------------------------------
 * Two places in the gateway compute it — the service that builds the page an
 * approver clicks, and the filter that verifies what comes back — and they must
 * produce byte-identical input or every signature fails. The same reasoning as
 * `client/tenant-args.ts`, where the query extension and the transaction wrapper
 * are two implementations of one rule and a disagreement between them leaks
 * cross-tenant data. Here the failure is the opposite and just as bad: a
 * disagreement means a link the system itself cannot verify, or — worse — one
 * signed over a *weaker* string than the verifier assumes.
 *
 * It lives in shared-types rather than in the gateway so that whoever issues
 * approval links next (a dashboard, an email service, a CLI) links against this
 * definition instead of re-deriving it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIGNATURE IS ISSUED, NOT COMPUTED BY THE APPROVER
 * ---------------------------------------------------------------------------
 * The approver is a person following a link in a browser. A browser cannot
 * compute an HMAC over a secret it does not hold. So the signature is minted
 * server-side, per action, with a bounded lifetime, and embedded in the page.
 *
 * That is a weaker guarantee than a header a trusted client signs per request,
 * and the trade is deliberate: the token is 256 bits of randomness, so the
 * signature's job is not to authenticate the approver — it is to stop the
 * *link* being edited. Signing the action means a signature lifted from the
 * "approve" button cannot be replayed against the "reject" endpoint, which is
 * the attack that matters when a page can be modified in transit or cached.
 */
import { APPROVAL_ACTIONS, type ApprovalAction } from '../enums/index.js';

/**
 * Signature scheme version, carried in the wire format so a future change is a
 * second accepted value rather than a breaking one.
 */
export const APPROVAL_SIGNATURE_VERSION = 'v1' as const;

/**
 * The header a caller would use if it were signing per request.
 *
 * The browser flow puts the same two values in the body — `signature` and
 * `timestamp` — so this is the documented name for the pair rather than
 * something the gateway currently reads off the wire. The timestamp is
 * deliberately *not* inside the signature string: it is a separate field the
 * verifier compares against the clock and against the string it re-signs, so a
 * caller cannot claim a timestamp the issuer never used.
 */
export const APPROVAL_SIGNATURE_HEADER = 'x-orbitoz-approval-signature';

/**
 * Default window, in seconds, during which a signature is accepted.
 *
 * Long enough that a person can read a page and click, short enough that a
 * signature harvested from a shared machine's history is dead by the next day.
 * Five minutes is the same order as an OTP code and is overridable per
 * deployment via `APPROVAL_SIGNATURE_TOLERANCE_SECONDS`.
 */
export const DEFAULT_APPROVAL_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Seconds an approval request stays decidable. */
export const DEFAULT_APPROVAL_TTL_SECONDS = 86_400;

/**
 * The exact string an approval signature covers.
 *
 * Three fields, and every one of them earns its place:
 *
 *   - `token`  binds the signature to one approval request. Without it, a
 *              signature is valid against *any* pending link.
 *   - `action` binds it to one decision. Without it, the signature on the
 *              "approve" button authorises a rejection as well — which is the
 *              difference between a workflow running and being silently killed.
 *   - `timestamp` makes the signature expire, and stops a captured signature
 *              being replayed forever.
 *
 * Separated by `.` rather than concatenated. A separator is what stops field
 * boundaries being ambiguous: without it, token `a.b` + action `C` and token `a`
 * + action `b.C` would sign the same bytes. The token is base64url, which
 * contains no `.`, so the split is unambiguous in practice — but the separator is
 * what makes it unambiguous by construction rather than by coincidence.
 */
export function approvalSigningPayload(
  token: string,
  action: ApprovalAction,
  timestampSeconds: number,
): string {
  return `${token}.${timestampSeconds}.${action}`;
}

/** The wire format: `v1=<hex hmac>`. */
export function formatApprovalSignature(macHex: string): string {
  return `${APPROVAL_SIGNATURE_VERSION}=${macHex}`;
}

export interface ParsedApprovalSignature {
  /**
   * The version marker, whatever it is.
   *
   * Parsed rather than validated here. A version this build does not understand
   * is still structurally a signature, and conflating "shape is wrong" with
   * "scheme is unsupported" would make the two indistinguishable to a caller and
   * leave `unsupported_version` as an unreachable branch. Shape belongs here;
   * policy belongs to the verifier.
   */
  readonly version: string;
  /** The HMAC, hex encoded. Compared with `timingSafeEqual`, never `===`. */
  readonly macHex: string;
}

export type ApprovalSignatureParse =
  | { readonly ok: true; readonly parsed: ParsedApprovalSignature }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Parses `<version>=<hex>` into its parts.
 *
 * Reports *every* problem rather than the first, for the same reason
 * `validateJobContext` does: a caller debugging a failing link should not have
 * to fix one mistake at a time.
 */
export function parseApprovalSignature(value: unknown): ApprovalSignatureParse {
  const problems: string[] = [];

  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, problems: ['signature must be a non-empty string'] };
  }

  const separator = value.indexOf('=');
  if (separator < 0) {
    return { ok: false, problems: ['signature must look like "<version>=<hex>"'] };
  }

  const version = value.slice(0, separator);
  const macHex = value.slice(separator + 1);

  // Hex only, and a fixed width. A base64 or truncated value would otherwise
  // reach the HMAC comparison and fail there with a less useful message — and
  // worse, could reach `timingSafeEqual` with two buffers of different lengths,
  // which throws instead of returning false.
  if (!/^[0-9a-f]{64}$/.test(macHex)) {
    problems.push('signature must be 64 lowercase hex characters');
  }
  if (version.length === 0) {
    problems.push('signature must carry a version before the separator');
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    parsed: { version, macHex },
  };
}

/**
 * The path an approver opens, relative to the API root.
 *
 * Relative, never absolute: the gateway cannot know its own public origin, and
 * building one from the `Host` header would hand an attacker a link that
 * resolves to wherever they asked for.
 */
export function approvalViewPath(token: string): string {
  return `/approvals/${encodeURIComponent(token)}`;
}

/** The path a decision is POSTed to. */
export function approvalDecisionPath(token: string): string {
  return approvalViewPath(token);
}

/** Narrows an untrusted string to an action, or reports it is not one. */
export function parseApprovalAction(value: unknown): ApprovalAction | null {
  return typeof value === 'string' && (APPROVAL_ACTIONS as readonly string[]).includes(value)
    ? (value as ApprovalAction)
    : null;
}
