/**
 * Guard tests.
 *
 * The guard is the last thing between a request and a handler, so these cover the
 * order of its decisions as carefully as the decisions themselves. The two
 * properties worth reading:
 *
 *   1. A valid token is never enough on its own. Host tenant, account status and
 *      role are each checked, and each fails closed.
 *   2. The failure mode is always an auth-domain error, never a bare `false`.
 *      Returning `false` would reach Nest's default 403 with no body; throwing
 *      reaches `AuthErrorFilter`, which is what lets the client tell "refresh
 *      your token" apart from "your token is not valid".
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { TENANT_ROLE_RANK, TenantRole, type UserStatus } from '@orbitoz/shared-types';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators.js';
import { TokenService, type TokenServiceConfig } from './token.service.js';
import { AuthService } from './auth.service.js';
import {
  InsufficientRoleError,
  InvalidCredentialsError,
  TenantMismatchError,
  TokenExpiredError,
  UnauthenticatedError,
} from './auth.errors.js';
import type { AuthenticatedRequest } from './auth.decorators.js';
import type { Principal } from './auth.types.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';

const CONFIG: TokenServiceConfig = {
  accessSecret: 'guard-test-access-secret-0123456789abcdef',
  refreshSecret: 'guard-test-refresh-secret-9876543210abcdef',
  accessTtlSeconds: 900,
  issuer: 'orbitoz.test',
  audience: 'orbitoz.test:api',
  clockToleranceSeconds: 0,
};

interface HarnessOptions {
  readonly isPublic?: boolean;
  readonly requiredRoles?: readonly string[];
  readonly hostTenantId?: string | null;
  readonly authorization?: string | readonly string[];
}

/**
 * Builds the guard and the context together.
 *
 * They have to be built together: the guard writes `request.auth` onto the request
 * it is handed, so a harness that returns a separately-constructed context would
 * assert against an object the guard never saw.
 */
function makeHarness(options: HarnessOptions = {}): {
  readonly guard: JwtAuthGuard;
  readonly context: ExecutionContext;
  readonly request: AuthenticatedRequest;
} {
  const request = {
    method: 'GET',
    url: '/protected',
    headers: { authorization: options.authorization },
  } as unknown as AuthenticatedRequest;

  const response = {
    locals:
      options.hostTenantId === null
        ? {}
        : { tenant: { tenantId: options.hostTenantId ?? TENANT_ID } },
  } as unknown as Response;

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => ({ handle: () => undefined }),
    }),
    // `Reflector.getAllAndOverride` is stubbed, so the handler reference is only
    // ever compared, never called.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    getHandler: () => function handler(): void {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;

  const reflector = {
    getAllAndOverride: (key: unknown): unknown => {
      if (key === IS_PUBLIC_KEY) return options.isPublic === true;
      if (key === ROLES_KEY) return options.requiredRoles;
      return undefined;
    },
  } as unknown as Reflector;

  const guard = new JwtAuthGuard(
    reflector,
    new TokenService(CONFIG),
    new AuthService({} as never, {} as never, new TokenService(CONFIG), {} as never),
  );

  return { guard, context, request };
}

/** Convenience for the common "build, act, assert on the request" shape. */
async function run(
  options: HarnessOptions,
): Promise<{ readonly allowed: boolean; readonly request: AuthenticatedRequest }> {
  const { guard, context, request } = makeHarness(options);
  const allowed = await guard.canActivate(context);
  return { allowed, request };
}

/** A well-formed token for the happy path, at the configured claims. */
async function tokenFor(): Promise<string> {
  return tokenWith({});
}

async function tokenWith(claims: {
  readonly userStatus?: UserStatus;
  readonly role?: (typeof TenantRole)[keyof typeof TenantRole];
  readonly tenantId?: string;
}): Promise<string> {
  const tokens = new TokenService(CONFIG);
  const { token } = await tokens.issueAccessToken({
    userId: USER_ID,
    tenantId: claims.tenantId ?? TENANT_ID,
    role: claims.role ?? TenantRole.Developer,
    email: 'dev@acme.test',
    userStatus: claims.userStatus ?? 'ACTIVE',
    isPlatformAdmin: false,
  });
  return token;
}

describe('JwtAuthGuard: route opt-out', () => {
  it('lets a @Public() route through with no token at all', async () => {
    const { guard, context } = makeHarness({ isPublic: true });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe('JwtAuthGuard: token extraction', () => {
  const malformed: readonly [string, string | undefined][] = [
    ['no Authorization header', undefined],
    ['an empty header', ''],
    ['the scheme alone', 'Bearer'],
    ['a space only', ' '],
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a bearer header with no token', 'Bearer '],
    ['a bearer header with only spaces after it', 'Bearer    '],
    ['a token with no scheme', 'abc.def.ghi'],
    ['a leading-space scheme that breaks the match', 'Bearerabc'],
  ];

  for (const [label, authorization] of malformed) {
    it(`rejects ${label}`, async () => {
      const { guard, context } = makeHarness({ authorization });
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthenticatedError);
    });
  }

  it('accepts a lowercase scheme, because RFC 7235 says it is case-insensitive', async () => {
    const token = await tokenFor();
    const authorization = `bearer ${token}`;
    const { guard, context, request } = makeHarness({ authorization });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.auth?.userId).toBe(USER_ID);
  });

  it('accepts an uppercase scheme', async () => {
    const token = await tokenFor();
    const authorization = `BEARER ${token}`;
    const { guard, context } = makeHarness({ authorization });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('ignores an array header rather than crashing on it', async () => {
    // Express types `authorization` as possibly `string[]` when a client sends the
    // header twice. It must be refused, not throw a TypeError into a 500.
    const { guard, context } = makeHarness({ authorization: ['Bearer a', 'Bearer b'] });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('JwtAuthGuard: token validity', () => {
  it('rejects a token signed with another key', async () => {
    const foreign = new TokenService({
      ...CONFIG,
      accessSecret: 'a-totally-different-secret-0123456789abcd',
    });
    const { token } = await foreign.issueAccessToken({
      userId: USER_ID,
      tenantId: TENANT_ID,
      role: TenantRole.Developer,
      email: 'dev@acme.test',
      userStatus: 'ACTIVE',
      isPlatformAdmin: false,
    });

    const { guard, context } = makeHarness({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects garbage in the Authorization header', async () => {
    const authorization = 'Bearer not-a-jwt-at-all';
    const { guard, context } = makeHarness({ authorization });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('signals an expired token distinctly, so the client knows to refresh', async () => {
    // A 401 for a bad token and a 401 for an expired one are the same status but
    // very different client behaviour: refresh and retry, versus sign in again.
    const tokens = new TokenService({ ...CONFIG, accessTtlSeconds: 1 });
    const { token } = await tokens.issueAccessToken({
      userId: USER_ID,
      tenantId: TENANT_ID,
      role: TenantRole.Developer,
      email: 'dev@acme.test',
      userStatus: 'ACTIVE',
      isPlatformAdmin: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const { guard, context } = makeHarness({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(TokenExpiredError);
  });
});

describe('JwtAuthGuard: tenant binding', () => {
  it('refuses a token whose tenant differs from the request host', async () => {
    // The core cross-tenant attack. RLS would accept this if the transaction were
    // pinned to the token's tenant; only the application knows which host the
    // request arrived on.
    const token = await tokenWith({ tenantId: OTHER_TENANT_ID });
    const authorization = `Bearer ${token}`;
    const { guard, context } = makeHarness({ authorization, hostTenantId: TENANT_ID });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('refuses a request with no resolved tenant at all', async () => {
    // Fails closed: a request that cannot be attributed to a tenant has no
    // business carrying tenant-scoped credentials.
    const token = await tokenFor();
    const authorization = `Bearer ${token}`;
    const { guard, context } = makeHarness({ authorization, hostTenantId: null });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('accepts a token whose tenant matches the host', async () => {
    const token = await tokenWith({ tenantId: TENANT_ID });
    const authorization = `Bearer ${token}`;
    const { allowed, request } = await run({ authorization, hostTenantId: TENANT_ID });

    expect(allowed).toBe(true);
    expect(request.auth).toMatchObject({ userId: USER_ID, tenantId: TENANT_ID });
  });

  it('checks the tenant before the role, so a mismatch is never reported as a role problem', async () => {
    // Reporting a tenant mismatch as "insufficient role" would tell an attacker
    // the token was otherwise acceptable.
    const token = await tokenWith({ tenantId: OTHER_TENANT_ID, role: TenantRole.Viewer });
    const authorization = `Bearer ${token}`;
    const { guard, context } = makeHarness({
      authorization,
      hostTenantId: TENANT_ID,
      requiredRoles: ['OWNER'],
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(TenantMismatchError);
  });
});

describe('JwtAuthGuard: account status', () => {
  for (const status of ['SUSPENDED', 'DEACTIVATED'] as const) {
    it(`refuses a ${status} account even with a valid signature`, async () => {
      // A signature proves the token was minted by us. It does not prove the
      // account is still usable.
      const token = await tokenWith({ userStatus: status });
      const authorization = `Bearer ${token}`;
      const { guard, context } = makeHarness({ authorization });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  }

  it('refuses a suspended account rather than reporting an auth failure', async () => {
    // InvalidCredentialsError maps to 401. A 403 here would tell the caller the
    // token was fine and the account merely lacked permission, which is both
    // wrong and more revealing.
    const token = await tokenWith({ userStatus: 'SUSPENDED' });
    const authorization = `Bearer ${token}`;
    const { guard, context } = makeHarness({ authorization });
    await expect(guard.canActivate(context)).rejects.not.toBeInstanceOf(InsufficientRoleError);
  });

  for (const status of ['ACTIVE', 'INVITED'] as const) {
    it(`accepts an ${status} account`, async () => {
      const token = await tokenWith({ userStatus: status });
      const authorization = `Bearer ${token}`;
      const { guard, context } = makeHarness({ authorization });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  }
});

describe('JwtAuthGuard: role enforcement', () => {
  async function roleOnRoute(
    role: (typeof TenantRole)[keyof typeof TenantRole],
    required: readonly string[],
  ): Promise<void> {
    const token = await tokenWith({ role });
    const { guard, context } = makeHarness({
      authorization: `Bearer ${token}`,
      requiredRoles: required,
    });
    await guard.canActivate(context);
  }

  it('permits a route that requires no particular role', async () => {
    await expect(roleOnRoute(TenantRole.Viewer, [])).resolves.toBeUndefined();
  });

  it('permits an exact role match', async () => {
    await expect(roleOnRoute(TenantRole.Developer, ['DEVELOPER'])).resolves.toBeUndefined();
  });

  it('permits a higher rank than required', async () => {
    // The rank table is what makes this hold without every caller restating the
    // hierarchy: an OWNER satisfies a route marked DEVELOPER.
    expect(TENANT_ROLE_RANK[TenantRole.Owner]).toBeGreaterThan(
      TENANT_ROLE_RANK[TenantRole.Developer],
    );
    await expect(roleOnRoute(TenantRole.Owner, ['DEVELOPER'])).resolves.toBeUndefined();
  });

  it('permits any role listed', async () => {
    await expect(
      roleOnRoute(TenantRole.Viewer, ['OWNER', 'DEVELOPER', 'VIEWER']),
    ).resolves.toBeUndefined();
  });

  it('refuses a role below the requirement', async () => {
    await expect(roleOnRoute(TenantRole.Viewer, ['OWNER'])).rejects.toBeInstanceOf(
      InsufficientRoleError,
    );
  });

  it('refuses DEVELOPER on a route that requires only OWNER', async () => {
    await expect(roleOnRoute(TenantRole.Developer, ['OWNER'])).rejects.toBeInstanceOf(
      InsufficientRoleError,
    );
  });

  it('refuses an unmapped role rather than defaulting it to permitted', async () => {
    // A role the rank table has never heard of must deny. Defaulting to 0 on both
    // sides would mean `required: [BILLING]` and an unknown role both rank 0, and
    // the `<=` comparison would let it through.
    const token = await tokenWith({
      role: 'SUPERUSER' as (typeof TenantRole)[keyof typeof TenantRole],
    });
    const authorization = `Bearer ${token}`;
    const { guard, context } = makeHarness({ authorization, requiredRoles: ['VIEWER'] });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(InsufficientRoleError);
  });

  it('does not leak the principal role in the error message', async () => {
    // The log line may name roles; the client-visible message must not, or it
    // confirms what the caller actually is.
    const token = await tokenWith({ role: TenantRole.Billing });
    const authorization = `Bearer ${token}`;
    const { guard, context } = makeHarness({ authorization, requiredRoles: ['OWNER'] });

    const error = await guard.canActivate(context).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(InsufficientRoleError);
    expect(JSON.stringify(error)).not.toContain(TenantRole.Billing);
  });
});

describe('JwtAuthGuard: request attachment', () => {
  it('attaches a principal carrying every claim a handler needs', async () => {
    const token = await tokenWith({ role: TenantRole.Admin });
    const authorization = `Bearer ${token}`;
    const { guard, context, request } = makeHarness({ authorization });
    await guard.canActivate(context);

    const principal: Principal | undefined = request.auth;
    expect(principal).toBeDefined();
    expect(principal).toMatchObject({
      userId: USER_ID,
      tenantId: TENANT_ID,
      email: 'dev@acme.test',
      role: TenantRole.Admin,
      userStatus: 'ACTIVE',
      isPlatformAdmin: false,
    });
    // Derived from the composite primary key of `memberships`.
    expect(principal?.membershipId).toBe(`${TENANT_ID}:${USER_ID}`);
    expect(principal?.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not attach a principal when the request is refused', async () => {
    // Otherwise a handler that runs after a caught error would find a half-built
    // identity on the request.
    const authorization = `Bearer ${await tokenWith({ tenantId: OTHER_TENANT_ID })}`;
    const { guard, context, request } = makeHarness({ authorization });
    await guard.canActivate(context).catch(() => undefined);

    expect(request.auth).toBeUndefined();
  });
});

describe('JwtAuthGuard: failure mode', () => {
  it('never resolves to false, only ever rejects', async () => {
    // `false` reaches Nest's bare 403 with no body and no way for the client to
    // know whether to refresh. Every refusal has to be a domain error so
    // `AuthErrorFilter` can shape it.
    const authorization = `Bearer ${await tokenFor()}`;
    const { guard, context } = makeHarness({ authorization, hostTenantId: null });

    const outcome = await guard.canActivate(context).then(
      (value) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, error }),
    );

    expect(outcome.resolved).toBe(false);
    expect(outcome.resolved === false && outcome.error).toBeInstanceOf(TenantMismatchError);
  });

  it('does not leak internal detail in a client-visible message', async () => {
    const authorization = `Bearer ${await tokenFor()}`;
    const { guard, context } = makeHarness({ authorization, hostTenantId: null });
    const error = (await guard.canActivate(context).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).not.toMatch(/secret|signature|stack|prisma|tokenHash|jwt/i);
  });

  it('does not leak the tenant id in a client-visible message', async () => {
    // The tenant ids go in the log line, where an operator needs them. The client
    // learns only that the two do not match.
    const authorization = `Bearer ${await tokenWith({ tenantId: OTHER_TENANT_ID })}`;
    const { guard, context } = makeHarness({ authorization, hostTenantId: TENANT_ID });
    const error = (await guard.canActivate(context).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).not.toContain(TENANT_ID);
    expect(error.message).not.toContain(OTHER_TENANT_ID);
  });
});
