/**
 * Token minting and verification.
 *
 * Two token types, deliberately asymmetric:
 *
 *   ACCESS  A signed JWT. Self-contained, so the guard can authenticate a
 *           request without a database round trip. Short-lived (15 minutes),
 *           because "self-contained" also means "cannot be revoked early" — the
 *           only thing bounding a stolen access token is its `exp`.
 *
 *   REFRESH An opaque 256-bit random string. Not a JWT, and that is the point:
 *           it has to be looked up in `refresh_tokens` on every use so it can be
 *           revoked, rotated, and family-revoked on replay. A refresh token
 *           that verified without a lookup could not be revoked at all.
 *
 * Why separate secrets: if both were signed with one key, a refresh token would
 * verify as an access token and hand out 14 days of access. Separate keys make
 * that structurally impossible rather than merely unlikely, and `env.ts` refuses
 * to boot if they are equal in production.
 *
 * Signatures are HS256 over a key derived from the secret. Symmetric because
 * both signer and verifier are this service; nothing else needs to validate a
 * token, so there is no reason to distribute a public key.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import { asTenantId, asUserId, type TenantRole, type UserStatus } from '@orbitoz/shared-types';

/** Token type claim. Mirrors RFC 8725 in spirit: a token says what it is for. */
export const TOKEN_TYPE = {
  Access: 'access',
  Refresh: 'refresh',
} as const;
export type TokenType = (typeof TOKEN_TYPE)[keyof typeof TOKEN_TYPE];

export interface AccessTokenClaims {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: TenantRole;
  readonly email: string;
  readonly userStatus: UserStatus;
  readonly isPlatformAdmin: boolean;
  /** Unique token id, so a specific access token can be named in an audit log. */
  readonly jti: string;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  readonly tenantId: string;
  readonly expiresAt: number;
}

export type TokenFailureReason =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_type'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'missing_claims';

export type TokenVerification =
  | { readonly ok: true; readonly claims: VerifiedAccessToken }
  | { readonly ok: false; readonly reason: TokenFailureReason };

export interface TokenServiceConfig {
  readonly accessSecret: string;
  readonly refreshSecret: string;
  readonly accessTtlSeconds: number;
  readonly issuer: string;
  readonly audience: string;
  readonly clockToleranceSeconds: number;
}

const ALGORITHM = 'HS256';

/**
 * Minimum key length for HS256 in `jose`.
 *
 * jose refuses to sign or verify with a key shorter than 32 bytes. Enforcing it
 * here turns an obscure runtime rejection deep inside a request into a startup
 * error naming the variable — the same reasoning as the secret length check in
 * `env.ts`.
 */
const MIN_KEY_BYTES = 32;

export class TokenService {
  private readonly accessKey: Uint8Array;

  constructor(private readonly config: TokenServiceConfig) {
    assertKeyLength(config.accessSecret, 'JWT_ACCESS_SECRET');
    assertKeyLength(config.refreshSecret, 'JWT_REFRESH_SECRET');
    this.accessKey = new TextEncoder().encode(config.accessSecret);
  }

  /** Mints an access token. `expiresIn` is seconds, per the shared DTO contract. */
  async issueAccessToken(
    claims: Omit<AccessTokenClaims, 'jti'>,
  ): Promise<{ readonly token: string; readonly expiresIn: number; readonly jti: string }> {
    const jti = randomUUID();
    const token = await new SignJWT({
      sub: claims.userId,
      tid: claims.tenantId,
      role: claims.role,
      email: claims.email,
      ust: claims.userStatus,
      pad: claims.isPlatformAdmin,
      typ: TOKEN_TYPE.Access,
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTtlSeconds}s`)
      .sign(this.accessKey);

    return { token, expiresIn: this.config.accessTtlSeconds, jti };
  }

  /**
   * Mints an opaque refresh token and the hash to persist.
   *
   * The plaintext is returned once and never stored; only `tokenHash` goes into
   * `refresh_tokens`. Hashing with SHA-256 rather than scrypt is the right call
   * here for a different reason than passwords: the input is 256 bits of
   * `crypto.randomBytes`, so there is no dictionary to attack and no need to
   * spend 70ms and 16 MiB per use on a request that may happen every 15 minutes.
   */
  issueRefreshToken(): { readonly token: string; readonly tokenHash: string } {
    const token = `ort_${randomBytes(32).toString('base64url')}`;
    return { token, tokenHash: hashRefreshToken(token) };
  }

  /**
   * Verifies an access token.
   *
   * Never throws: every failure mode collapses to `{ ok: false, reason }`, so a
   * caller cannot accidentally treat one failure as another. In particular
   * `expired` and `bad_signature` are kept apart — a client needs to know
   * whether to refresh or to re-authenticate.
   */
  async verifyAccessToken(token: string): Promise<TokenVerification> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.accessKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockToleranceSeconds,
        // An explicit allowlist. Without it, a token signed with an unrelated
        // algorithm — `none`, or an attacker-chosen symmetric algorithm — could
        // be presented here and pass verification.
        algorithms: [ALGORITHM],
      });
      payload = result.payload;
    } catch (error) {
      return { ok: false, reason: classifyJoseError(error) };
    }

    if (payload.typ !== TOKEN_TYPE.Access) return { ok: false, reason: 'wrong_type' };

    const { sub, tid, role, email, ust, pad, jti, exp } = payload;
    if (
      typeof sub !== 'string' ||
      typeof tid !== 'string' ||
      typeof role !== 'string' ||
      typeof email !== 'string' ||
      typeof ust !== 'string' ||
      typeof pad !== 'boolean' ||
      typeof jti !== 'string' ||
      typeof exp !== 'number'
    ) {
      return { ok: false, reason: 'missing_claims' };
    }

    return {
      ok: true,
      claims: {
        userId: sub,
        tenantId: tid,
        role: role as TenantRole,
        email,
        userStatus: ust as UserStatus,
        isPlatformAdmin: pad,
        jti,
        expiresAt: exp,
      },
    };
  }

  /**
   * The tenant and user a token was minted for, without verifying it.
   *
   * ONLY for logging a rejected request — "token for tenant X was refused" is
   * worth having, and reading the claims of an unverified token is safe for
   * exactly that purpose. Never use the result for an authorization decision.
   */
  peekUnverified(token: string): { userId: string; tenantId: string } | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    try {
      const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (typeof payload !== 'object' || payload === null) return null;
      const { sub, tid } = payload as { sub?: unknown; tid?: unknown };
      if (typeof sub !== 'string' || typeof tid !== 'string') return null;
      return { userId: sub, tenantId: tid };
    } catch {
      return null;
    }
  }
}

/**
 * SHA-256 of a refresh token, hex-encoded.
 *
 * Shared with `refresh_tokens.token_hash`, which is `VarChar(128)` — hex is
 * exactly 64 characters, so the column has room to spare and stays indexable
 * without a format change.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function classifyJoseError(error: unknown): TokenFailureReason {
  if (error instanceof joseErrors.JWTExpired) return 'expired';
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return 'bad_signature';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = error.claim;
    if (claim === 'iss') return 'wrong_issuer';
    if (claim === 'aud') return 'wrong_audience';
  }
  if (error instanceof joseErrors.JWTInvalid) {
    return 'malformed';
  }
  return 'malformed';
}

function assertKeyLength(secret: string, variable: string): void {
  if (new TextEncoder().encode(secret).length < MIN_KEY_BYTES) {
    throw new Error(
      `${variable} must be at least ${MIN_KEY_BYTES} bytes for ${ALGORITHM}. ` +
        'Generate one with `openssl rand -base64 48`.',
    );
  }
}

/**
 * Branded projection of verified claims, for attaching to the request.
 *
 * Kept next to the verifier so there is one place that knows how a token's
 * claims map onto the application's identity types.
 */
export function toPrincipal(claims: VerifiedAccessToken): {
  readonly userId: ReturnType<typeof asUserId>;
  readonly tenantId: ReturnType<typeof asTenantId>;
  readonly role: TenantRole;
} {
  return {
    userId: asUserId(claims.userId),
    tenantId: asTenantId(claims.tenantId),
    role: claims.role,
  };
}
