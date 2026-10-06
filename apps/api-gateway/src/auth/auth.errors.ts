/**
 * Domain errors for the auth module.
 *
 * Each carries the canonical `ErrorCode` from `@orbitoz/shared-types`, so the
 * HTTP layer never has to infer a status or invent a code string. Clients switch
 * on the code; the message is for humans and is deliberately vague where being
 * specific would leak information.
 */

/** Base class so a single `catch` can distinguish auth failures from faults. */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Sign-in failed.
 *
 * One error for "no such user", "wrong password", "not a member of this tenant"
 * and "account disabled" — all of them `INVALID_CREDENTIALS` with the same
 * message. Distinguishing them would tell an attacker which emails have accounts
 * on a given subdomain, which is the reconnaissance step before a credential
 * stuffing run.
 */
export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('INVALID_CREDENTIALS', 'Invalid email or password.');
  }
}

export class EmailAlreadyRegisteredError extends AuthError {
  constructor() {
    super('EMAIL_ALREADY_REGISTERED', 'That email address already has an account.');
  }
}

export class SlugAlreadyTakenError extends AuthError {
  constructor() {
    super('SLUG_ALREADY_TAKEN', 'That organization subdomain is already in use.');
  }
}

/** The tenant resolved from the request host is not in a servable state. */
export class TenantNotServableError extends AuthError {
  constructor(message: string) {
    super('TENANT_SUSPENDED', message);
  }
}

export class UnauthenticatedError extends AuthError {
  constructor(message = 'Authentication is required.') {
    super('UNAUTHENTICATED', message);
  }
}

export class TokenExpiredError extends AuthError {
  constructor() {
    super('TOKEN_EXPIRED', 'This token has expired.');
  }
}

export class TokenRevokedError extends AuthError {
  constructor(reason: string) {
    super('TOKEN_REVOKED', `This token is no longer valid: ${reason}.`);
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = 'You do not have access to this resource.') {
    super('FORBIDDEN', message);
  }
}

export class InsufficientRoleError extends AuthError {
  constructor(required: readonly string[]) {
    super('INSUFFICIENT_ROLE', `This action requires one of: ${required.join(', ')}.`);
  }
}

/**
 * The token's tenant and the request host's tenant disagree.
 *
 * A distinct error from a plain 403 because it means the client is pointed at the
 * wrong subdomain for the session it holds — almost always a stale tab after a
 * tenant switch, occasionally a confused-deputy attempt. The 409 status tells the
 * client to re-resolve its tenant rather than retry.
 */
export class TenantMismatchError extends AuthError {
  constructor() {
    super(
      'TENANT_MISMATCH',
      'This session was issued for a different tenant than the one addressed by this request.',
    );
  }
}

/** Weak password. Field-level, so the UI can point at the right input. */
export class WeakPasswordError extends AuthError {
  constructor(readonly problems: readonly string[]) {
    super('VALIDATION_FAILED', 'Password does not meet the security policy.');
  }
}
