/**
 * Controller tests.
 *
 * No HTTP server. The controller is a thin translation layer — validate a body,
 * pull the tenant off `response.locals`, delegate — so what is worth testing is
 * the translation: which field errors surface, what happens when the tenant was
 * never resolved, and whether client metadata is truncated to the column widths.
 *
 * Calling the methods directly is a fair way to test a controller in Nest: every
 * parameter arrives as an explicit argument, so the decorators are elided and
 * only real logic is exercised.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { TenantRole } from '@orbitoz/shared-types';
import { AuthController } from './auth.controller.js';
import type { AuthService, RequestTenant } from './auth.service.js';
import type { AuthenticatedRequest } from './auth.decorators.js';
import type { Principal } from './auth.types.js';
import { TenantNotServableError, UnauthenticatedError } from './auth.errors.js';

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

const SESSION = {
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'dev@acme.test',
    name: 'Dev',
    status: 'ACTIVE',
    isPlatformAdmin: false,
    avatarUrl: null,
  },
  tenant: {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'acme',
    name: 'Acme',
    plan: 'FREE',
    role: TenantRole.Owner,
    memberships: [],
  },
  accessToken: 'access.jwt.token',
  refreshToken: 'ort_refresh',
  tokenType: 'Bearer',
  expiresIn: 900,
};

const TENANT = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  slug: 'acme',
  status: 'TRIALING',
  plan: 'FREE',
  suspendedAt: null,
} as RequestTenant;

/**
 * Sentinel for "the middleware resolved no tenant".
 *
 * A separate constant, because `makeResponse(NO_TENANT)` would hit the default
 * parameter and quietly attach the real tenant — making the test pass for the
 * wrong reason.
 */
const NO_TENANT = Symbol('no-tenant');

function makeResponse(tenant: unknown = TENANT, requestId?: string): Response {
  return {
    locals: {
      ...(tenant === NO_TENANT ? {} : { tenant }),
      ...(requestId === undefined ? {} : { requestId }),
    },
  } as unknown as Response;
}

function makeRequest(
  headers: Record<string, unknown> = {},
  auth?: Principal,
): AuthenticatedRequest {
  return { headers, auth } as unknown as AuthenticatedRequest;
}

/**
 * A stub `AuthService`.
 *
 * The methods are `async` with no `await` because that is what the real ones are:
 * the controller's only job is to hand off, and a stub that awaited something would
 * be testing a flow it does not own.
 */
function makeService(): AuthService {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    registerTenant: vi.fn(async () => SESSION),
    // eslint-disable-next-line @typescript-eslint/require-await
    login: vi.fn(async () => SESSION),
    // eslint-disable-next-line @typescript-eslint/require-await
    me: vi.fn(async () => ({ user: SESSION.user, tenant: SESSION.tenant })),
    // eslint-disable-next-line @typescript-eslint/require-await
    refresh: vi.fn(async () => SESSION),
    // eslint-disable-next-line @typescript-eslint/require-await
    signOut: vi.fn(async () => undefined),
  } as unknown as AuthService;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

describe('register', () => {
  const valid = {
    organizationName: 'Acme Inc',
    slug: 'acme',
    adminName: 'Dev',
    adminEmail: 'dev@acme.test',
    adminPassword: 'a-sufficiently-long-password',
  };

  function call(body: unknown, request = makeRequest(), response = makeResponse()) {
    const service = makeService();
    return {
      service,
      promise: new AuthController(service).register(body, request, response, '198.51.100.9'),
    };
  }

  it('passes a valid body through to the service', async () => {
    const { service, promise } = call(valid);
    await expect(promise).resolves.toEqual(SESSION);
    expect(service.registerTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationName: 'Acme Inc',
        slug: 'acme',
        adminEmail: 'dev@acme.test',
      }),
    );
  });

  it('lowercases the slug before the service sees it', async () => {
    // The slug becomes a subdomain, and DNS is case-insensitive but the database
    // column is not. Normalising at the edge keeps one row per tenant.
    const { service, promise } = call({ ...valid, slug: 'ACME' });
    await promise;
    expect(vi.mocked(service.registerTenant).mock.calls[0]?.[0].slug).toBe('acme');
  });

  it('trims whitespace from every string field', async () => {
    const { service, promise } = call({
      ...valid,
      organizationName: '  Acme Inc  ',
      adminEmail: '  dev@acme.test  ',
    });
    await promise;
    const input = vi.mocked(service.registerTenant).mock.calls[0]?.[0];
    expect(input?.organizationName).toBe('Acme Inc');
    expect(input?.adminEmail).toBe('dev@acme.test');
  });

  it('defaults a missing admin name to an empty string', async () => {
    const { adminName: _omitted, ...withoutName } = valid;
    const { service, promise } = call(withoutName);
    await expect(promise).resolves.toEqual(SESSION);
    expect(vi.mocked(service.registerTenant).mock.calls[0]?.[0].adminName).toBe('');
  });

  const rejected: readonly [string, Record<string, unknown>][] = [
    ['a missing organization name', { organizationName: undefined }],
    ['a one-character organization name', { organizationName: 'A' }],
    ['an over-long organization name', { organizationName: 'A'.repeat(201) }],
    ['a missing slug', { slug: undefined }],
    ['an empty slug', { slug: '' }],
    ['a 64-character slug', { slug: 'a'.repeat(64) }],
    ['a malformed email', { adminEmail: 'not-an-email' }],
    ['an email with no @', { adminEmail: 'nope' }],
    ['a missing password', { adminPassword: undefined }],
    ['an empty password', { adminPassword: '' }],
    ['an over-long password', { adminPassword: 'a'.repeat(201) }],
  ];

  for (const [label, override] of rejected) {
    it(`rejects ${label} with a 400`, async () => {
      const { promise } = call({ ...valid, ...override });
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    });
  }

  // Separate from the table above: these replace the body outright. Spreading
  // them into the valid body would be a no-op, which is exactly the bug these
  // cases exist to catch.
  for (const [label, body] of [
    ['a null body', null],
    ['an array body', []],
    ['a string body', 'not-an-object'],
    ['a number body', 42],
    ['an empty object', {}],
  ] as const) {
    it(`rejects ${label} with a 400`, async () => {
      const { promise } = call(body);
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    });
  }

  it('names the offending field, so a form can point at it', async () => {
    const { promise } = call({ ...valid, adminEmail: 'nope' });
    const error = (await promise.catch((e: unknown) => e)) as BadRequestException;

    const body = error.getResponse() as { message: { path: string; message: string }[] };
    expect(body.message.map((issue) => issue.path)).toContain('adminEmail');
    for (const issue of body.message) {
      expect(issue.message).toBeTypeOf('string');
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('reports every invalid field at once', async () => {
    // One round trip per problem is a worse experience than a complete list.
    const { promise } = call({
      organizationName: '',
      slug: '',
      adminEmail: 'x',
      adminPassword: '',
    });
    const error = (await promise.catch((e: unknown) => e)) as BadRequestException;
    const body = error.getResponse() as { message: { path: string }[] };

    expect(body.message.length).toBeGreaterThanOrEqual(4);
  });

  it('does not call the service for an invalid body', async () => {
    const { service, promise } = call({ ...valid, adminEmail: 'nope' });
    await promise.catch(() => undefined);
    expect(service.registerTenant).not.toHaveBeenCalled();
  });

  it('records the request id from the response locals', async () => {
    const { service, promise } = call(valid, makeRequest(), makeResponse(TENANT, 'req-9'));
    await promise;
    expect(vi.mocked(service.registerTenant).mock.calls[0]?.[0].requestId).toBe('req-9');
  });

  it('falls back to "unknown" when no request id was attached', async () => {
    const { service, promise } = call(valid, makeRequest(), makeResponse());
    await promise;
    expect(vi.mocked(service.registerTenant).mock.calls[0]?.[0].requestId).toBe('unknown');
  });

  it('does not require a resolved tenant', async () => {
    // Registration happens *before* a tenant exists, so it is excluded from
    // TenantMiddleware. Requiring a tenant here would make signup unreachable.
    const { promise } = call(valid, makeRequest(), makeResponse(NO_TENANT));
    await expect(promise).resolves.toEqual(SESSION);
  });
});

describe('login', () => {
  function call(body: unknown, response = makeResponse()) {
    const service = makeService();
    return {
      service,
      promise: new AuthController(service).login(body, makeRequest(), response, '198.51.100.9'),
    };
  }

  it('passes the tenant resolved from the request host to the service', async () => {
    const { service, promise } = call({ email: 'dev@acme.test', password: 'a-password' });
    await expect(promise).resolves.toEqual(SESSION);
    expect(vi.mocked(service.login).mock.calls[0]?.[1]).toMatchObject({
      tenantId: TENANT.tenantId,
    });
  });

  it('refuses when no tenant was resolved', async () => {
    // Sign-in is a decision about a specific tenant. Without one there is nothing
    // to check a membership against, and guessing would be a cross-tenant hole.
    const { promise } = call(
      { email: 'dev@acme.test', password: 'x'.repeat(20) },
      makeResponse(NO_TENANT),
    );
    await expect(promise).rejects.toBeInstanceOf(TenantNotServableError);
  });

  it('trims but does not case-fold the email; the service owns normalisation', async () => {
    // Casing is a service decision (`normalizeEmail`), not a schema one. Keeping
    // the schema to whitespace means there is exactly one place where an address
    // is folded to a lookup key, and it is the one that also handles registration.
    const { service, promise } = call({ email: '  DEV@Acme.Test ', password: 'a-password' });
    await promise;
    expect(vi.mocked(service.login).mock.calls[0]?.[0].email).toBe('DEV@Acme.Test');
  });

  const rejected: readonly [string, unknown][] = [
    ['a missing email', { password: 'x'.repeat(20) }],
    ['a missing password', { email: 'dev@acme.test' }],
    ['an empty password', { email: 'dev@acme.test', password: '' }],
    ['a 201-character password', { email: 'dev@acme.test', password: 'a'.repeat(201) }],
    ['a null body', null],
  ];

  for (const [label, body] of rejected) {
    it(`rejects ${label} with a 400`, async () => {
      const { promise } = call(body);
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    });
  }

  it('does not reveal whether the email is valid before reaching the service', async () => {
    // Email plausibility is the service's decision, not the schema's: rejecting a
    // malformed address here would make this endpoint an enumeration oracle.
    const { promise } = call({ email: 'definitely-not-an-email', password: 'a-password' });
    await expect(promise).resolves.toEqual(SESSION);
  });
});

describe('refresh', () => {
  function call(body: unknown, response = makeResponse()) {
    const service = makeService();
    return {
      service,
      promise: new AuthController(service).refresh(body, makeRequest(), response, '198.51.100.9'),
    };
  }

  it('rotates the presented token against the resolved tenant', async () => {
    const { service, promise } = call({ refreshToken: 'ort_x' });
    await expect(promise).resolves.toEqual(SESSION);
    expect(vi.mocked(service.refresh).mock.calls[0]?.[0]).toBe('ort_x');
    expect(vi.mocked(service.refresh).mock.calls[0]?.[1]).toMatchObject({
      tenantId: TENANT.tenantId,
    });
  });

  it('refuses when no tenant was resolved', async () => {
    const { promise } = call({ refreshToken: 'ort_x' }, makeResponse(NO_TENANT));
    await expect(promise).rejects.toBeInstanceOf(TenantNotServableError);
  });

  for (const [label, body] of [
    ['a missing token', {}],
    ['an empty token', { refreshToken: '' }],
    ['a 513-character token', { refreshToken: 'a'.repeat(513) }],
    ['a null body', null],
  ] as const) {
    it(`rejects ${label} with a 400`, async () => {
      const { promise } = call(body);
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    });
  }
});

describe('logout', () => {
  function call(body: unknown) {
    const service = makeService();
    return {
      service,
      promise: new AuthController(service).logout(body, makeRequest(), '198.51.100.9'),
    };
  }

  it('resolves with no body for a valid token', async () => {
    const { service, promise } = call({ refreshToken: 'ort_x' });
    await expect(promise).resolves.toBeUndefined();
    expect(service.signOut).toHaveBeenCalledWith('ort_x', expect.any(Object));
  });

  it('does not require a tenant', async () => {
    // Sign-out revokes a family named by the token row itself, so it works even
    // when the tenant can no longer be resolved from the host.
    const { promise } = call({ refreshToken: 'ort_x' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects a missing token with a 400', async () => {
    const { promise } = call({});
    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('me', () => {
  const principal: Principal = {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: TENANT.tenantId,
    email: 'dev@acme.test',
    role: TenantRole.Developer,
    userStatus: 'ACTIVE',
    isPlatformAdmin: false,
    membershipId: `${TENANT.tenantId}:11111111-1111-4111-8111-111111111111`,
    jti: 'jti-1',
  };

  it('reads the principal the guard attached', async () => {
    // The guard is the only thing that sets `request.auth`. Reading it here is
    // what lets `/auth/me` re-check the live role instead of trusting the token.
    const service = makeService();
    await new AuthController(service).me(makeRequest({}, principal), makeResponse());

    expect(vi.mocked(service.me).mock.calls[0]?.[0]).toMatchObject({
      userId: principal.userId,
      tenantId: TENANT.tenantId,
    });
  });

  it('returns no tokens', async () => {
    // A GET that rotated the refresh token would break clients that do not write
    // the new value back on every page load.
    const service = makeService();
    const view = await new AuthController(service).me(makeRequest({}, principal), makeResponse());

    expect(view).not.toHaveProperty('accessToken');
    expect(view).not.toHaveProperty('refreshToken');
    expect(vi.mocked(service.refresh)).not.toHaveBeenCalled();
  });

  it('throws rather than reading undefined when no principal is attached', async () => {
    // Unreachable behind the guard. Checked anyway so a direct call fails with a
    // clear message instead of a TypeError three frames down.
    const service = makeService();
    await expect(
      new AuthController(service).me(makeRequest(), makeResponse()),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('refuses when no tenant was resolved', async () => {
    const service = makeService();
    await expect(
      new AuthController(service).me(makeRequest({}, principal), makeResponse(NO_TENANT)),
    ).rejects.toBeInstanceOf(TenantNotServableError);
  });
});

/* -------------------------------------------------------------------------- */
/* Fingerprint                                                                 */
/* -------------------------------------------------------------------------- */

describe('client fingerprint', () => {
  function fingerprintFor(headers: Record<string, unknown>, ip = '198.51.100.9') {
    const service = makeService();
    return new AuthController(service)
      .login(
        { email: 'dev@acme.test', password: 'a-password' },
        makeRequest(headers),
        makeResponse(),
        ip,
      )
      .then(() => vi.mocked(service.login).mock.calls[0]?.[0].fingerprint);
  }

  it('prefers the first x-forwarded-for entry over the socket address', async () => {
    // The gateway always sits behind a load balancer, so the socket address is the
    // balancer. Recording that would make every audit row name the same host.
    const fingerprint = await fingerprintFor({ 'x-forwarded-for': '203.0.113.7, 198.51.100.1' });
    expect(fingerprint?.ipAddress).toBe('203.0.113.7');
  });

  it('handles an array-valued x-forwarded-for header', async () => {
    const fingerprint = await fingerprintFor({
      'x-forwarded-for': ['203.0.113.7', '198.51.100.1'],
    });
    expect(fingerprint?.ipAddress).toBe('203.0.113.7');
  });

  it('falls back to the socket address when the header is absent', async () => {
    expect((await fingerprintFor({}))?.ipAddress).toBe('198.51.100.9');
  });

  it('falls back when the header is empty or only commas', async () => {
    expect((await fingerprintFor({ 'x-forwarded-for': '' }))?.ipAddress).toBe('198.51.100.9');
    expect((await fingerprintFor({ 'x-forwarded-for': ' , , ' }))?.ipAddress).toBe('198.51.100.9');
  });

  it('reports null when neither source has an address', async () => {
    expect((await fingerprintFor({}, ''))?.ipAddress).toBeNull();
  });

  it('truncates a long ip to the column width', async () => {
    // `ip_address` is VarChar(45), the longest textual IPv6 form. Truncating keeps
    // a spoofed header from becoming an insert error.
    const long = '203.0.113.7'.repeat(10);
    const fingerprint = await fingerprintFor({ 'x-forwarded-for': long });
    expect(fingerprint?.ipAddress).toHaveLength(45);
  });

  it('records the user agent', async () => {
    expect((await fingerprintFor({ 'user-agent': 'vitest/1.0' }))?.userAgent).toBe('vitest/1.0');
  });

  it('truncates a long user agent to the column width', async () => {
    const fingerprint = await fingerprintFor({ 'user-agent': 'x'.repeat(600) });
    expect(fingerprint?.userAgent).toHaveLength(512);
  });

  it('reports null for a missing user agent', async () => {
    expect((await fingerprintFor({}))?.userAgent).toBeNull();
  });
});
