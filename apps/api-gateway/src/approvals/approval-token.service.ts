/**
 * Approval token generation and verification.
 *
 * ---------------------------------------------------------------------------
 * WHY AN OPAQUE TOKEN AND NOT A SIGNED ONE
 * ---------------------------------------------------------------------------
 * The obvious choice is a JWT, since the gateway already issues them. It is the
 * wrong choice here, and `token.service.ts` already explains why for refresh
 * tokens: a self-contained credential cannot be revoked. An approval token is
 * *entirely* about revocation — the whole point of the row is that a decision
 * can be spent exactly once, and that an expired or superseded link stops
 * working. A token that verified without a lookup could not be spent once.
 *
 * So: 256 bits from the CSPRNG, stored as a SHA-256 hash, resolved by index
 * lookup on every use. The cost is one database read per decision, which is
 * already being paid — the decision itself is a write.
 *
 * ---------------------------------------------------------------------------
 * WHY HASHED RATHER THAN STORED
 * ---------------------------------------------------------------------------
 * A database dump, a read replica or a support query must not yield a working
 * approval link. SHA-256 is used rather than a password hash because the input
 * is 256 bits of CSPRNG output — there is no dictionary to attack and no work
 * factor that adds anything but latency on the hot path. Refreshing a token is a
 * lookup, and the lookup is on an indexed `CHAR(64)` column, so the hash is a
 * row key rather than a scan.
 *
 * The consequence worth stating: `verify` cannot be a comparison, it is a
 * lookup. There is no timing-safe comparison to perform afterwards, because the
 * match is an exact index match inside Postgres.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Bytes of randomness in a token. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

export interface IssuedApprovalToken {
  /** The token to put in the approver's URL. Never persisted. */
  readonly token: string;
  /** What goes in `approval_requests.token_hash`. */
  readonly tokenHash: string;
}

export class ApprovalTokenService {
  /**
   * Mints a token and its hash.
   *
   * `base64url` rather than hex: same entropy in two thirds the characters, and
   * safe in a URL path segment without escaping — which matters because the token
   * *is* a path segment in `/approvals/:token`. `randomBytes` is the CSPRNG;
   * `Math.random` would make every token guessable by an attacker who has seen a
   * few thousand of them.
   */
  issue(): IssuedApprovalToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, tokenHash: hashApprovalToken(token) };
  }

  /**
   * The hash for a token presented by a caller.
   *
   * Also used to reject an over-long token *before* hashing it: an unbounded
   * input would otherwise be hashed and used as an index key on every request,
   * which is a cheap way to make a public endpoint expensive.
   */
  hash(token: string): string {
    return hashApprovalToken(token);
  }
}

/**
 * Length of a token this service minted.
 *
 * 32 bytes base64url-encoded is always 43 characters, and is asserted rather
 * than assumed because the assertion is what lets the controller reject a
 * malformed token with a 404 without a database round trip.
 */
export const APPROVAL_TOKEN_LENGTH = 43;

/** Whether a presented token could be one of ours, before touching the database. */
export function looksLikeApprovalToken(token: string): boolean {
  return token.length === APPROVAL_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token);
}

/**
 * SHA-256 of a token, hex encoded.
 *
 * Exported separately from the class so the seeder, a test fixture, or any
 * future reconciliation script hashes the same way the service does. A second
 * copy of this function is a second definition of "the same token".
 */
export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
