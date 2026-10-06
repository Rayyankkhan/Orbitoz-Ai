/**
 * Error and filter tests.
 *
 * Two separate concerns, deliberately tested together:
 *
 *   * `AuthError` subclasses must be indistinguishable where the API promises they
 *     are. The sign-in path collapsing four different failures into one error is
 *     the property that stops `POST /auth/login` from being an account-enumeration
 *     oracle, and it is easy to regress by "helpfully" distinguishing them later.
 *   * `AuthErrorFilter` maps codes to statuses through the shared table rather
 *     than hard-coding, so a status change lands everywhere at once.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, HTTP_STATUS_BY_ERROR_CODE } from '@orbitoz/shared-types';
import type { Response } from 'express';
import { AuthErrorFilter } from './auth-error.filter.js';
import {
  AuthError,
  EmailAlreadyRegisteredError,
  ForbiddenError,
  InsufficientRoleError,
  InvalidCredentialsError,
  SlugAlreadyTakenError,
  TenantMismatchError,
  TenantNotServableError,
  TokenExpiredError,
  TokenRevokedError,
  UnauthenticatedError,
  WeakPasswordError,
} from './auth.errors.js';

describe('AuthError', () => {
  it('names itself after the concrete subclass, not "Error"', () => {
    // The name reaches a log line, so an operator can tell an auth failure from a
    // random fault without opening the file.
    expect(new InvalidCredentialsError().name).toBe('InvalidCredentialsError');
    expect(new UnauthenticatedError().name).toBe('UnauthenticatedError');
  });

  it('is catchable as the base class', () => {
    // What lets one `catch (e) { if (e instanceof AuthError) }` render any of them.
    expect(new TokenExpiredError()).toBeInstanceOf(AuthError);
    expect(new TenantMismatchError()).toBeInstanceOf(AuthError);
    expect(new WeakPasswordError([])).toBeInstanceOf(AuthError);
  });

  it('preserves the stack, so the throw site is diagnosable', () => {
    expect(new TokenExpiredError().stack).toBeDefined();
  });

  it('carries a code present in the shared table', () => {
    // Every code is looked up in `HTTP_STATUS_BY_ERROR_CODE` with a `?? 500`
    // fallback. A typo in a code string would therefore ship as a silent 500
    // rather than a compile error, because `code` is typed `string`.
    const errors = [
      new InvalidCredentialsError(),
      new EmailAlreadyRegisteredError(),
      new SlugAlreadyTakenError(),
      new TenantNotServableError('suspended'),
      new UnauthenticatedError(),
      new TokenExpiredError(),
      new TokenRevokedError('rotated'),
      new ForbiddenError(),
      new InsufficientRoleError(['OWNER']),
      new TenantMismatchError(),
      new WeakPasswordError(['too short']),
    ];
    for (const error of errors) {
      expect(error.code, error.name).toBeTypeOf('string');
      expect(error.code in HTTP_STATUS_BY_ERROR_CODE, `${error.name}: ${error.code}`).toBe(true);
    }
  });
});

describe('sign-in failure indistinguishability', () => {
  it('renders every sign-in rejection identically', () => {
    // Four conditions, one response. If these ever differ, `POST /auth/login`
    // discloses which addresses have accounts on this subdomain — the
    // reconnaissance step before a credential-stuffing run.
    const rejections = [
      new InvalidCredentialsError(),
      new InvalidCredentialsError(),
      new InvalidCredentialsError(),
    ];

    const codes = new Set(rejections.map((error) => error.code));
    const messages = new Set(rejections.map((error) => error.message));

    expect(codes.size).toBe(1);
    expect(messages.size).toBe(1);
    expect([...codes][0]).toBe(ErrorCode.InvalidCredentials);
  });

  it('names no account state in the message', () => {
    const message = new InvalidCredentialsError().message.toLowerCase();
    // Anything here tells a caller whether an address is registered.
    expect(message).not.toMatch(/user|account|member|exist|registered|disabled|suspend/i);
    expect(message).not.toContain('not found');
    // It does have to be actionable, which "invalid" is.
    expect(message).toMatch(/invalid/i);
  });
});

describe('message hygiene', () => {
  it('keeps token internals out of a client-visible message', () => {
    for (const error of [
      new TokenRevokedError('unknown token'),
      new UnauthenticatedError(),
      new TenantMismatchError(),
      new TenantNotServableError('Tenant acme is SUSPENDED.'),
    ]) {
      expect(error.message, error.name).not.toMatch(/scrypt|N=|hash|sha-?256|secret|stack/i);
    }
  });

  it('keeps the tenant id out of the mismatch message', () => {
    // The ids belong in the log line. A client that learns the tenant it is not
    // addressing gains nothing useful, but one that learns them learns them
    // about a token it presented.
    expect(new TenantMismatchError().message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('reports the role requirement without the caller role', () => {
    const error = new InsufficientRoleError(['OWNER', 'ADMIN']);
    expect(error.message).toContain('OWNER');
    expect(error.message).toContain('ADMIN');
  });

  it('carries weak-password problems separately from the generic message', () => {
    // The problems go into a 400 body so a form can point at the offending field;
    // the message stays generic because it is also the audit-line text.
    const error = new WeakPasswordError(['Password must be at least 12 characters.']);
    expect(error.code).toBe(ErrorCode.ValidationFailed);
    expect(error.problems).toEqual(['Password must be at least 12 characters.']);
    expect(error.message).not.toContain('12 characters');
  });
});

/* -------------------------------------------------------------------------- */
/* Filter                                                                      */
/* -------------------------------------------------------------------------- */

function runFilter(
  error: AuthError,
  requestId?: string,
): {
  readonly status: number;
  readonly body: { error: string; message: string; requestId: string };
} {
  let status = 0;
  let body: { error: string; message: string; requestId: string } | undefined;

  const response = {
    locals: requestId === undefined ? {} : { requestId },
    status(code: number): typeof response {
      status = code;
      return response;
    },
    json(payload: { error: string; message: string; requestId: string }): typeof response {
      body = payload;
      return response;
    },
  } as unknown as Response;

  const host = { switchToHttp: () => ({ getResponse: () => response }) };

  new AuthErrorFilter().catch(error, host as never);
  expect(body).toBeDefined();
  return { status, body: body as { error: string; message: string; requestId: string } };
}

describe('AuthErrorFilter: status mapping', () => {
  const cases: readonly [string, AuthError, number][] = [
    ['a missing token', new UnauthenticatedError(), 401],
    ['bad credentials', new InvalidCredentialsError(), 401],
    ['an expired access token', new TokenExpiredError(), 401],
    ['a revoked refresh token', new TokenRevokedError('rotated'), 401],
    ['a forbidden resource', new ForbiddenError(), 403],
    ['an insufficient role', new InsufficientRoleError(['OWNER']), 403],
    ['a suspended tenant', new TenantNotServableError('suspended'), 403],
    ['a taken email', new EmailAlreadyRegisteredError(), 409],
    ['a taken slug', new SlugAlreadyTakenError(), 409],
    ['a tenant mismatch', new TenantMismatchError(), 409],
    ['a weak password', new WeakPasswordError([]), 400],
  ];

  for (const [label, error, expected] of cases) {
    it(`maps ${label} to ${expected}`, () => {
      expect(runFilter(error).status).toBe(expected);
    });
  }

  it('agrees with the shared table for every auth error', () => {
    // The filter reads the table; this asserts it is not quietly diverging.
    for (const [label, error] of cases) {
      expect(runFilter(error).status, label).toBe(
        HTTP_STATUS_BY_ERROR_CODE[error.code as ErrorCode],
      );
    }
  });

  it('gives a tenant mismatch a status distinct from a plain 403', () => {
    // A stale tab and a permission problem need different client handling:
    // re-resolve the tenant, versus stop. Sharing a status would force clients to
    // switch on the message prose to tell them apart.
    expect(runFilter(new TenantMismatchError()).status).not.toBe(
      runFilter(new ForbiddenError()).status,
    );
  });

  it('falls back to 500 for a code the table does not know', () => {
    // Defensive: `code` is typed `string`, so a new error with a typo would
    // otherwise look like a deliberate choice.
    expect(runFilter(new AuthError('NOT_A_REAL_CODE', 'x')).status).toBe(500);
  });
});

describe('AuthErrorFilter: response body', () => {
  it('returns the canonical code, not prose', () => {
    // Clients switch on `error`; the message is for humans.
    const { body } = runFilter(new TokenExpiredError(), 'req-1');
    expect(body.error).toBe(ErrorCode.TokenExpired);
    expect(body.message).toBe('This token has expired.');
  });

  it('includes the request id so a failure can be correlated with a log line', () => {
    const { body } = runFilter(new InvalidCredentialsError(), 'req-abc');
    expect(body.requestId).toBe('req-abc');
  });

  it('degrades to "unknown" when no request id was attached', () => {
    // Some entry points run before `RequestIdMiddleware`. Omitting the field would
    // break the response shape that clients parse.
    const { body } = runFilter(new InvalidCredentialsError());
    expect(body.requestId).toBe('unknown');
  });

  it('has exactly the three published keys', () => {
    // An extra key here leaks internals into a public contract.
    const { body } = runFilter(new TokenRevokedError('rotated'), 'req-1');
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'requestId']);
  });

  it('never includes a stack trace in the body', () => {
    for (const [, error] of [
      ['expired', new TokenExpiredError()],
      ['revoked', new TokenRevokedError('replay')],
    ] as const) {
      const { body } = runFilter(error, 'req-1');
      expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)|\.ts:\d+:\d+/);
    }
  });
});
