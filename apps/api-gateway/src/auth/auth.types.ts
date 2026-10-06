/**
 * Auth module contracts.
 *
 * These are plain interfaces rather than classes so a test can supply a stub
 * without a Nest testing module. The trade is that a caller could inject any
 * implementation — acceptable because the token is provided by the module that
 * owns it, and a wrong implementation fails at wiring time in `auth.module.ts`,
 * not silently at runtime.
 */
import type { SessionTenant, SessionUser, TenantRole, UserStatus } from '@orbitoz/shared-types';

/** Where a request's client metadata comes from, when it is trustworthy. */
export interface RequestFingerprint {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * The authenticated principal, as attached to the request.
 *
 * Structural mirror of `AuthenticatedUser` in `@orbitoz/shared-types`. It is
 * redeclared here rather than imported because `membershipId` is a derived value
 * the database package cannot produce — `memberships` has a composite primary
 * key `(tenantId, userId)` and no surrogate id.
 */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: TenantRole;
  readonly userStatus: UserStatus;
  readonly isPlatformAdmin: boolean;
  /** `${tenantId}:${userId}` — the composite key of the `memberships` row. */
  readonly membershipId: string;
  readonly jti: string;
}

/**
 * The session identity returned by every auth endpoint.
 *
 * `AuthSession` in `@orbitoz/shared-types` extends this with the token pair.
 * `GET /auth/me` returns only this part, because a read must not mint or rotate
 * a refresh token.
 */
export interface AuthSessionView {
  readonly user: SessionUser;
  readonly tenant: SessionTenant;
}

/** The `users` columns every auth read selects. */
export interface SessionUserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly status: string;
  readonly isPlatformAdmin: boolean;
  readonly avatarUrl: string | null;
}

/**
 * Account status that may hold a session.
 *
 * `INVITED` counts as usable: an invited member who has set a password has an
 * account, and requiring an email-confirmation round trip before their first
 * request would be a UX decision, not a security one. `SUSPENDED` and
 * `DEACTIVATED` do not.
 */
export function isActiveStatus(status: UserStatus): boolean {
  return status === 'ACTIVE' || status === 'INVITED';
}

/** Account status that may not sign in. */
export const SIGN_IN_BLOCKED_STATUSES: readonly UserStatus[] = ['SUSPENDED', 'DEACTIVATED'];

export function canSignIn(status: UserStatus): boolean {
  return !SIGN_IN_BLOCKED_STATUSES.includes(status);
}

/**
 * Password policy.
 *
 * Length is the dominant factor in password strength, so the minimum is 12
 * rather than the conventional 8, and there is no composition rule — a rule
 * demanding one of each character class measurably pushes users toward
 * `Password1!`-style substitutions without making the password stronger.
 *
 * The breach list is a fixed set of the most-used leaked passwords. Rejecting
 * them is close to free and removes the passwords an attacker tries first.
 */
export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 200,
  /** bcrypt-style truncation is not a concern for scrypt, but an unbounded
   *  password is a cheap way to burn 16 MiB and 70ms of CPU per request. */
  blocked: new Set([
    'password',
    'password1',
    'password123',
    'password1234',
    '123456789012',
    'qwertyuiopas',
    'letmeinplease',
    'iloveyou123',
    'administrator',
    'welcome12345',
    'changeme1234',
    'orbitoz12345',
  ]),
} as const;

export interface PasswordPolicyViolation {
  readonly rule: 'too_short' | 'too_long' | 'blocked';
  readonly message: string;
}

/**
 * Validates a password against {@link PASSWORD_POLICY}.
 *
 * @returns an empty array when the password is acceptable.
 */
export function checkPasswordPolicy(password: string): readonly PasswordPolicyViolation[] {
  const problems: PasswordPolicyViolation[] = [];

  if (password.length < PASSWORD_POLICY.minLength) {
    problems.push({
      rule: 'too_short',
      message: `Password must be at least ${PASSWORD_POLICY.minLength} characters.`,
    });
  }
  if (password.length > PASSWORD_POLICY.maxLength) {
    problems.push({
      rule: 'too_long',
      message: `Password must be at most ${PASSWORD_POLICY.maxLength} characters.`,
    });
  }
  if (PASSWORD_POLICY.blocked.has(password.toLowerCase())) {
    problems.push({
      rule: 'blocked',
      message: 'This password appears in a list of commonly breached passwords.',
    });
  }

  return problems;
}

/**
 * Normalises an email for storage and lookup.
 *
 * Trimmed and lowercased. The address is the primary key for sign-in, so
 * `Alice@Example.com` and `alice@example.com` must be the same account or a user
 * who changes their email casing locks themselves out. `users.email` is
 * `VarChar(320)`, which is the RFC 5321 maximum.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A syntactically plausible email address.
 *
 * Deliberately permissive: the authoritative test is whether a confirmation mail
 * arrives. Rejecting an address that RFC 5322 permits would block a legitimate
 * user for a formatting technicality, and the only addresses that reach here are
 * ones a person typed.
 */
export function isPlausibleEmail(email: string): boolean {
  if (email.length === 0 || email.length > 320) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64) return false;
  if (domain.length === 0 || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  // ASCII only. An internationalised domain arrives as punycode (`xn--...`), and
  // accepting a raw U-label would store an address in a form no mail provider
  // recognises. Rejecting it is the honest failure; converting it is a separate
  // decision that belongs with the mail service.
  if (/[^a-z0-9.-]/.test(domain)) return false;
  // Reject whitespace and control characters. `\s` covers most of the C0 range
  // plus the space characters; the explicit ranges catch the remainder, which
  // includes NUL and DEL. `no-control-regex` is disabled for this one line
  // because the control characters *are* the thing being rejected.
  // eslint-disable-next-line no-control-regex
  return !/[\s\u0000-\u001f\u007f]/.test(email);
}

/**
 * Validates a tenant slug.
 *
 * DNS-label rules, because the slug becomes a subdomain:
 * `acme.orbitoz.ai`. Underscores are excluded even though DNS permits them in
 * some records — they are not valid in a hostname, and a slug that cannot be a
 * hostname is a slug that will not resolve.
 */
export function isValidTenantSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);
}
