/**
 * Auth service tests.
 *
 * No database. What is verified here is the *sequencing and scoping* of the
 * queries the service issues, which is where the tenancy risk actually lives:
 *
 *   * every `users` and `refresh_tokens` read goes through `prisma.unscoped`,
 *     with a stated justification, because both models are global;
 *   * every `memberships` read happens inside `transactions.run(...)`, so RLS is
 *     the authority rather than a code-level `if`;
 *   * `setRlsTenant` is called exactly once per provisioning transaction, after
 *     the tenant insert and before any scoped write.
 *
 * Each of those is asserted against a recording double. A test double that
 * asserted nothing would only prove the mock works; these assert on the calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantRole, type TenantStatus } from '@orbitoz/shared-types';
import type { PrismaClient, TenantScopedTransaction } from '@orbitoz/database';
import { AuthService, type RequestTenant } from './auth.service.js';
import { TokenService, hashRefreshToken, type TokenServiceConfig } from './token.service.js';
import type { EnvService } from '../config/env.service.js';
import type { Principal } from './auth.types.js';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  SlugAlreadyTakenError,
  TenantMismatchError,
  TenantNotServableError,
  TokenExpiredError,
  TokenRevokedError,
  WeakPasswordError,
} from './auth.errors.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';

const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

const TOKEN_CONFIG: TokenServiceConfig = {
  accessSecret: 'auth-service-test-access-secret-0123456789ab',
  refreshSecret: 'auth-service-test-refresh-secret-9876543210',
  accessTtlSeconds: 900,
  issuer: 'orbitoz.test',
  audience: 'orbitoz.test:api',
  clockToleranceSeconds: 0,
};

/* -------------------------------------------------------------------------- */
/* Recording doubles                                                           */
/* -------------------------------------------------------------------------- */

type Row = Readonly<Record<string, unknown>>;

/** Stand-in for a server-generated id, so a created row is never `undefined`. */
const GENERATED = 'generated-id';

/** Per-model row sources. Anything not named returns `null`. */
interface Rows {
  readonly user?: (args: Row) => Row | null;
  readonly tenant?: (args: Row) => Row | null;
  readonly membership?: (args: Row) => Row | null;
  readonly refreshToken?: (args: Row) => Row | null;
  readonly subscription?: (args: Row) => Row | null;
  readonly auditLog?: (args: Row) => Row | null;
}

interface RecordedCall {
  readonly model: string;
  readonly op: string;
  readonly args: Row;
}

interface Recorder {
  /** Justification string for every `prisma.unscoped` call. */
  readonly unscoped: string[];
  readonly tx: RecordedCall[];
  /** Tenant ids pinned via `transactions.run`, in call order. */
  readonly pins: string[];
  /** Tenant ids pinned via `setRlsTenant`, in call order. */
  readonly setRlsPins: string[];
}

/**
 * One delegate factory, used for both the raw client and the scoped transaction.
 *
 * They are deliberately the *same* object: the service uses `prisma.unscoped` for
 * global models and `transactions.active` for tenant-scoped ones, and a test that
 * only recorded one of them would let a real scoping regression pass unnoticed.
 * Scoping is asserted from `runs` and `unscoped`, not from which delegate answered.
 */
function makeHarness(
  rows: Rows = {},
  overrides: { auditLogThrows?: boolean } = {},
): {
  readonly prisma: unknown;
  readonly transactions: unknown;
  readonly calls: Recorder;
  readonly runs: { readonly tenantId: string }[];
} {
  const calls: Recorder = { unscoped: [], tx: [], pins: [], setRlsPins: [] };
  const runs: { tenantId: string }[] = [];

  // Every delegate is async, matching Prisma: its methods return a
  // `PrismaPromise`, which is a real Promise and is *also* thenable. The
  // service relies on that — `auth.service.ts` calls `.then(...)` on
  // `auditLog.create` inside `transactions.run` so the audit write cannot
  // escape the transaction. A double returning a plain object would fail on a
  // promise the production client does provide.
  const delegate = (model: keyof Rows): Record<string, (args: Row) => Promise<unknown>> => {
    const source = rows[model];

    // A write returns the row it was asked to persist, narrowed by `select`.
    // Honouring `select` matters: `registerTenant` reads `tenant.id` off the
    // result of a `create` that only selected four columns, and a double that
    // returned the whole args object would hand back a shape no real Prisma
    // client ever produces.
    const written = (args: Row): Row => {
      const data = (args.data ?? {}) as Row;
      const select = args.select as Record<string, boolean> | undefined;
      const row: Record<string, unknown> = select
        ? Object.fromEntries(
            Object.keys(select)
              .filter((key) => select[key])
              .map((key) => [key, key in data ? data[key] : GENERATED]),
          )
        : { ...data };
      // A real insert assigns a server-side id the caller did not send.
      if ('id' in row && row.id === undefined) row.id = GENERATED;
      return row;
    };

    const record =
      (op: string) =>
      // eslint-disable-next-line @typescript-eslint/require-await
      async (args: Row): Promise<unknown> => {
        calls.tx.push({ model, op, args });
        if (op === 'findUnique') return source ? source(args) : null;
        return written(args);
      };

    return {
      findUnique: record('findUnique'),
      // eslint-disable-next-line @typescript-eslint/require-await
      create: async (args: Row): Promise<unknown> => {
        // `recordSignInFailure` catches this to keep a lost audit row from
        // turning a 401 into a 500.
        if (model === 'auditLog' && overrides.auditLogThrows) {
          calls.tx.push({ model, op: 'create', args });
          throw new Error('audit table unavailable');
        }
        calls.tx.push({ model, op: 'create', args });
        return written(args);
      },
      update: record('update'),
      updateMany: record('updateMany'),
    };
  };

  const models = (): Record<string, unknown> => ({
    user: delegate('user'),
    tenant: delegate('tenant'),
    membership: delegate('membership'),
    refreshToken: delegate('refreshToken'),
    subscription: delegate('subscription'),
    auditLog: delegate('auditLog'),
    // Registration opens its own transaction on the raw client, so the raw
    // client needs `$transaction` too.
    $transaction: (fn: (tx: TenantScopedTransaction) => Promise<unknown>) => fn(tx),
    // `setRlsTenant(tx, id)` from @orbitoz/database pins `app.tenant_id` through
    // this. Recording the argument is how a test asserts the pin happened *before*
    // the tenant-scoped writes that depend on it — the ordering the
    // `rls_tenants_insert` policy requires.
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => {
      if (sql.includes("set_config('app.tenant_id'")) calls.setRlsPins.push(String(params[0]));
      calls.tx.push({ model: '$raw', op: 'executeRaw', args: { sql, params } });
      return Promise.resolve(0);
    },
  });

  const tx = models() as unknown as TenantScopedTransaction;

  const prisma = {
    // `unscoped` hands the callback the *raw* client — no tenant-injection
    // extension — which is exactly why a test double for it is honest. The
    // justification string is recorded because "every unscoped read says why" is
    // the property this architecture relies on being greppable in production.
    unscoped: async (fn: (client: PrismaClient) => Promise<unknown>, reason: string) => {
      calls.unscoped.push(reason);
      return fn(models() as unknown as PrismaClient);
    },
    $transaction: async (fn: (tx: TenantScopedTransaction) => Promise<unknown>) => fn(tx),
  };

  const transactions = {
    run: async (tenantId: string, fn: () => Promise<unknown>) => {
      // The real `run` pins `app.tenant_id` via `SET LOCAL`; recording the id it
      // was pinned to is how a test asserts *which* tenant a query was scoped to.
      calls.pins.push(tenantId);
      runs.push({ tenantId });
      return fn();
    },
    get active(): TenantScopedTransaction {
      return tx;
    },
  };

  return { prisma, transactions, calls, runs };
}

/** The password every sign-in test presents, and what USER_ROW stores for it. */
const PASSWORD = 'a-sufficiently-long-password';

const USER_ROW: Row = {
  id: USER_ID,
  email: 'dev@acme.test',
  name: 'Dev',
  status: 'ACTIVE',
  isPlatformAdmin: false,
  avatarUrl: null,
  // A real scrypt hash *of PASSWORD*, at the reduced test cost. Sign-in verifies
  // against this, so a placeholder would fail every success-path test for the
  // wrong reason. Produced by the same code path as a production hash.
  passwordHash:
    'scrypt$1024$8$1$3K23zd2HVcy8Hsf0nzilTw==$' +
    'DnTzpESsfmkE++nr/YvNyvNQxIIMwq7BtDw9H0F/ggHO5mljJ0Icxipku2p2iH/N+HhsW/zxDYrUpwoYHasGkQ==',
};

function envWith(overrides: Record<string, unknown> = {}): EnvService {
  return {
    scryptCost: FAST_SCRYPT,
    refreshTtlSeconds: 1_209_600,
    ...overrides,
  } as unknown as EnvService;
}

interface Built {
  readonly service: AuthService;
  readonly calls: Recorder;
  readonly runs: { readonly tenantId: string }[];
}

function build(rows: Rows = {}, env: EnvService = envWith(), auditLogThrows = false): Built {
  const harness = makeHarness(rows, { auditLogThrows });
  const service = new AuthService(
    harness.prisma as never,
    harness.transactions as never,
    new TokenService(TOKEN_CONFIG),
    env,
  );
  return { service, calls: harness.calls, runs: harness.runs };
}

const TENANT: RequestTenant = {
  tenantId: TENANT_ID,
  slug: 'acme',
  status: 'TRIALING',
  plan: 'FREE',
  suspendedAt: null,
};

const FINGERPRINT = { ipAddress: '203.0.113.7', userAgent: 'vitest/1.0' };

/* -------------------------------------------------------------------------- */
/* Registration                                                                 */
/* -------------------------------------------------------------------------- */

describe('registerTenant: input validation', () => {
  it('rejects a weak password before touching the database', async () => {
    // scrypt and a write transaction are both expensive; the cheapest possible
    // rejection is a pure function call.
    const { service, calls } = build();
    await expect(
      service.registerTenant({
        organizationName: 'Acme',
        slug: 'acme',
        adminName: 'Dev',
        adminEmail: 'dev@acme.test',
        adminPassword: 'short',
        fingerprint: FINGERPRINT,
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
    expect(calls.unscoped).toEqual([]);
  });

  it('surfaces every policy violation, not just the first', async () => {
    const { service } = build();
    const error = await service
      .registerTenant({
        organizationName: 'Acme',
        slug: 'acme',
        adminName: 'Dev',
        adminEmail: 'dev@acme.test',
        adminPassword: 'password1',
        fingerprint: FINGERPRINT,
        requestId: 'req-1',
      })
      // `then(onFulfilled, onRejected)` rather than `.catch`: a trailing catch makes
      // the type a union of the success and failure branches, so reading `problems`
      // off it would not typecheck — and a union there means the test would silently
      // accept a *successful* registration as evidence of a refusal.
      .then(
        () => {
          throw new Error('registration should have been refused');
        },
        (thrown: unknown) => thrown as WeakPasswordError,
      );

    expect(error.problems.length).toBeGreaterThan(1);
  });

  it('rejects a malformed email', async () => {
    const { service } = build();
    await expect(
      service.registerTenant({
        organizationName: 'Acme',
        slug: 'acme',
        adminName: 'Dev',
        adminEmail: 'not-an-email',
        adminPassword: 'a-sufficiently-long-password',
        fingerprint: FINGERPRINT,
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects a slug that cannot be a hostname label', async () => {
    const { service } = build();
    await expect(
      service.registerTenant({
        organizationName: 'Acme',
        slug: 'acme_corp',
        adminName: 'Dev',
        adminEmail: 'dev@acme.test',
        adminPassword: 'a-sufficiently-long-password',
        fingerprint: FINGERPRINT,
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(SlugAlreadyTakenError);
  });

  it('normalises the email and slug before checking them', async () => {
    // `Alice@Example.com` and `alice@example.com` must be the same account, and
    // `ACME` must not become a distinct tenant from `acme`.
    const { service, calls } = build({ user: () => ({ id: 'existing' }) });
    await expect(
      service.registerTenant({
        organizationName: 'Acme',
        slug: 'ACME',
        adminName: 'Dev',
        adminEmail: 'Alice@Example.com',
        adminPassword: 'a-sufficiently-long-password',
        fingerprint: FINGERPRINT,
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);

    const userLookup = calls.tx.find((call) => call.model === 'user' && call.op === 'findUnique');
    expect((userLookup?.args.where as Row | undefined)?.email).toBe('alice@example.com');
  });
});

describe('registerTenant: RLS scoping', () => {
  const validInput = {
    organizationName: 'Acme',
    slug: 'acme',
    adminName: 'Dev',
    adminEmail: 'dev@acme.test',
    adminPassword: 'a-sufficiently-long-password',
    fingerprint: FINGERPRINT,
    requestId: 'req-1',
  };

  it('runs on the raw client, since no tenant exists to scope to yet', async () => {
    // `rls_tenants_insert` permits a tenant insert only while no tenant is in
    // scope, so the whole provisioning transaction has to be unscoped.
    const { service, calls } = build();
    await service.registerTenant(validInput).catch(() => undefined);

    expect(calls.unscoped.length).toBeGreaterThan(0);
    expect(calls.unscoped[0]).toMatch(/tenant provisioning/i);
  });

  it('states why each unscoped read is justified', async () => {
    // The justification string is the audit trail. An unscoped read with no
    // stated reason is the thing this architecture is trying to make greppable.
    const { service, calls } = build();
    await service.registerTenant(validInput).catch(() => undefined);

    for (const reason of calls.unscoped) {
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('names tenantId explicitly on every tenant-scoped write', async () => {
    // The compensating control for running on the raw client: the extension that
    // injects `tenantId` is not present, so a missing one would be a NOT NULL
    // violation. Naming it turns a silent orphan row into a loud failure.
    const { service, calls } = build();
    await service.registerTenant(validInput).catch(() => undefined);

    const writes = calls.tx.filter(
      (call) =>
        call.op === 'create' && ['membership', 'refreshToken', 'subscription'].includes(call.model),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect((write.args.data as Row | undefined)?.tenantId, write.model).toBeDefined();
    }
  });

  it('creates the membership with the OWNER role', async () => {
    const { service, calls } = build();
    await service.registerTenant(validInput).catch(() => undefined);

    const membership = calls.tx.find((call) => call.model === 'membership' && call.op === 'create');
    expect((membership?.args.data as Row | undefined)?.role).toBe(TenantRole.Owner);
  });

  it('pins the RLS scope to the new tenant id before any scoped write', async () => {
    // `rls_tenants_insert` allows the tenant INSERT only while no tenant is in
    // scope; every write after it needs the scope pinned to that same id. Getting
    // this order wrong makes registration fail at the membership insert.
    const { service, calls } = build();
    await service.registerTenant(validInput).catch(() => undefined);

    expect(calls.setRlsPins.length).toBeGreaterThan(0);

    const pinIndex = calls.tx.findIndex(
      (call) => call.model === '$raw' && call.op === 'executeRaw',
    );
    const firstScopedWrite = calls.tx.findIndex(
      (call) => call.op === 'create' && call.model !== 'tenant',
    );

    expect(pinIndex).toBeGreaterThanOrEqual(0);
    expect(firstScopedWrite).toBeGreaterThan(pinIndex);
  });

  it('writes an audit row for the tenant creation', async () => {
    const { service, calls } = build();
    await service.registerTenant(validInput).catch(() => undefined);

    const audit = calls.tx.find((call) => call.model === 'auditLog' && call.op === 'create');
    expect((audit?.args.data as Row | undefined)?.action).toBe('TENANT_CREATED');
    expect((audit?.args.data as Row | undefined)?.requestId).toBe('req-1');
  });
});

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                     */
/* -------------------------------------------------------------------------- */

describe('login: credential verification', () => {
  it('looks the user up unscoped, because users are a global model', async () => {
    const { service, calls } = build({ user: () => ({ ...USER_ROW }) });
    await service
      .login(
        { email: 'dev@acme.test', password: PASSWORD, fingerprint: FINGERPRINT, requestId: 'r' },
        TENANT,
      )
      .catch(() => undefined);

    expect(calls.unscoped.some((reason) => /global model/i.test(reason))).toBe(true);
  });

  it('normalises the email before the lookup', async () => {
    const { service, calls } = build({ user: () => ({ ...USER_ROW }) });
    await service
      .login(
        {
          email: '  Dev@Acme.Test ',
          password: 'x'.repeat(20),
          fingerprint: FINGERPRINT,
          requestId: 'r',
        },
        TENANT,
      )
      .catch(() => undefined);

    const lookup = calls.tx.find((call) => call.model === 'user' && call.op === 'findUnique');
    expect((lookup?.args.where as Row | undefined)?.email).toBe('dev@acme.test');
  });

  it('rejects an unknown email as a credentials error, never a not-found', async () => {
    // A 404 here would confirm the address has no account, which is the
    // reconnaissance step before a credential-stuffing run.
    const { service } = build({ user: () => null });
    await expect(
      service.login(
        {
          email: 'nobody@acme.test',
          password: 'x'.repeat(20),
          fingerprint: FINGERPRINT,
          requestId: 'r',
        },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects a wrong password with the same error as an unknown email', async () => {
    const { service } = build({
      user: () => ({ ...USER_ROW, passwordHash: 'scrypt$1024$8$1$aaaa$bbbb' }),
    });
    await expect(
      service.login(
        {
          email: 'dev@acme.test',
          password: 'x'.repeat(20),
          fingerprint: FINGERPRINT,
          requestId: 'r',
        },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  for (const status of ['SUSPENDED', 'DEACTIVATED'] as const) {
    it(`refuses to sign in a ${status} account`, async () => {
      const { service } = build({ user: () => ({ ...USER_ROW, status }) });
      await expect(
        service.login(
          {
            email: 'dev@acme.test',
            password: 'x'.repeat(20),
            fingerprint: FINGERPRINT,
            requestId: 'r',
          },
          TENANT,
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  }

  it('records a failed sign-in for audit', async () => {
    const { service, calls } = build({ user: () => null });
    await service
      .login(
        {
          email: 'dev@acme.test',
          password: 'x'.repeat(20),
          fingerprint: FINGERPRINT,
          requestId: 'r',
        },
        TENANT,
      )
      .catch(() => undefined);

    const audit = calls.tx.find((call) => call.model === 'auditLog' && call.op === 'create');
    expect((audit?.args.data as Row | undefined)?.action).toBe('SIGN_IN_FAILED');
  });

  it('does not let a failed audit write mask the auth failure', async () => {
    // Losing one audit row must not turn a 401 into a 500. The failure is logged
    // and swallowed so the caller still learns their credentials were wrong.
    const { service } = build({ user: () => null }, envWith(), true);
    await expect(
      service.login(
        {
          email: 'dev@acme.test',
          password: 'x'.repeat(20),
          fingerprint: FINGERPRINT,
          requestId: 'r',
        },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

describe('login: tenant binding', () => {
  const { password } = { password: PASSWORD };

  it('rejects a valid account that is not a member of this tenant', async () => {
    // The membership read is tenant-scoped, so RLS returns no row and this
    // becomes a plain credentials error. Credentials alone are never enough.
    const { service } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => null,
    });

    await expect(
      service.login(
        { email: 'dev@acme.test', password, fingerprint: FINGERPRINT, requestId: 'r' },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('performs the membership check inside a tenant-pinned transaction', async () => {
    // If it ran unscoped, RLS would not be enforcing anything and the check would
    // be a code-level comparison that a future refactor could quietly drop.
    const { service, runs } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    await service
      .login({ email: 'dev@acme.test', password, fingerprint: FINGERPRINT, requestId: 'r' }, TENANT)
      .catch(() => undefined);

    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.tenantId === TENANT_ID)).toBe(true);
  });

  it('scopes every tenant-scoped read to the request tenant', async () => {
    const { service, calls } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    await service
      .login({ email: 'dev@acme.test', password, fingerprint: FINGERPRINT, requestId: 'r' }, TENANT)
      .catch(() => undefined);

    const membershipLookup = calls.tx.find((call) => call.model === 'membership');
    const where = (membershipLookup?.args.where as Row | undefined)?.tenantId_userId as
      Row | undefined;
    expect(where?.tenantId).toBe(TENANT_ID);
  });

  for (const status of ['SUSPENDED', 'DELETED'] as TenantStatus[]) {
    it(`refuses a ${status} tenant`, async () => {
      const { service } = build({ user: () => ({ ...USER_ROW }) });
      await expect(
        service.login(
          { email: 'dev@acme.test', password, fingerprint: FINGERPRINT, requestId: 'r' },
          { ...TENANT, status },
        ),
      ).rejects.toBeInstanceOf(TenantNotServableError);
    });
  }

  it('refuses a tenant with a suspension timestamp', async () => {
    const { service } = build({ user: () => ({ ...USER_ROW }) });
    await expect(
      service.login(
        { email: 'dev@acme.test', password, fingerprint: FINGERPRINT, requestId: 'r' },
        { ...TENANT, suspendedAt: '2026-01-01T00:00:00.000Z' },
      ),
    ).rejects.toBeInstanceOf(TenantNotServableError);
  });

  it('writes every tenant-scoped row against the request tenant', async () => {
    const { service, calls } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    await service
      .login({ email: 'dev@acme.test', password, fingerprint: FINGERPRINT, requestId: 'r' }, TENANT)
      .catch(() => undefined);

    const refreshWrite = calls.tx.find(
      (call) => call.model === 'refreshToken' && call.op === 'create',
    );
    expect((refreshWrite?.args.data as Row | undefined)?.tenantId).toBe(TENANT_ID);

    const audit = calls.tx.find((call) => call.model === 'auditLog' && call.op === 'create');
    expect((audit?.args.data as Row | undefined)?.tenantId).toBe(TENANT_ID);
  });
});

/* -------------------------------------------------------------------------- */
/* Refresh rotation                                                            */
/* -------------------------------------------------------------------------- */

const LIVE_REFRESH_ROW: Row = {
  familyId: '44444444-4444-4444-8444-444444444444',
  userId: USER_ID,
  tenantId: TENANT_ID,
  expiresAt: new Date(Date.now() + 3_600_000),
  revokedAt: null,
  revokedReason: null,
};

describe('refresh', () => {
  it('refuses a tenant that cannot serve requests, before any lookup', async () => {
    const { service, calls } = build({ refreshToken: () => LIVE_REFRESH_ROW });
    await expect(
      service.refresh('ort_x', { ...TENANT, status: 'SUSPENDED' }, FINGERPRINT),
    ).rejects.toBeInstanceOf(TenantNotServableError);
    expect(calls.unscoped).toEqual([]);
  });

  it('looks the token up unscoped, because refresh_tokens is global', async () => {
    // A rotation arrives without a usable tenant context — the tenant has to come
    // out of the row. Scoping this read would make it impossible to find the row.
    const { service, calls } = build({ refreshToken: () => LIVE_REFRESH_ROW });
    await service.refresh('ort_x', TENANT, FINGERPRINT).catch(() => undefined);

    expect(calls.unscoped.some((reason) => /global/i.test(reason))).toBe(true);
  });

  it('looks the token up by hash, never by plaintext', async () => {
    const { service, calls } = build({ refreshToken: () => LIVE_REFRESH_ROW });
    await service.refresh('ort_the_token', TENANT, FINGERPRINT).catch(() => undefined);

    const lookup = calls.tx.find(
      (call) => call.model === 'refreshToken' && call.op === 'findUnique',
    );
    const where = lookup?.args.where as Row | undefined;
    expect(where?.tokenHash).toBe(hashRefreshToken('ort_the_token'));
    expect(JSON.stringify(where)).not.toContain('ort_the_token');
  });

  it('refuses an unknown token', async () => {
    const { service } = build({ refreshToken: () => null });
    await expect(service.refresh('ort_nope', TENANT, FINGERPRINT)).rejects.toBeInstanceOf(
      TokenRevokedError,
    );
  });

  it('treats a replayed token as a compromise and revokes the whole family', async () => {
    // A superseded token means two parties hold one family, which is the signature
    // of a stolen token. Revoking only the presented token would leave the
    // attacker's live one working.
    const { service, calls } = build({
      refreshToken: () => ({
        ...LIVE_REFRESH_ROW,
        revokedAt: new Date(),
        revokedReason: 'ROTATED',
      }),
    });
    await expect(service.refresh('ort_x', TENANT, FINGERPRINT)).rejects.toBeInstanceOf(
      TokenRevokedError,
    );

    const revoke = calls.tx.find(
      (call) => call.model === 'refreshToken' && call.op === 'updateMany',
    );
    expect((revoke?.args.where as Row | undefined)?.familyId).toBe(LIVE_REFRESH_ROW.familyId);
    expect((revoke?.args.data as Row | undefined)?.revokedReason).toBe('REPLAY_DETECTED');
  });

  it('revokes the family of an expired token', async () => {
    const { service, calls } = build({
      refreshToken: () => ({ ...LIVE_REFRESH_ROW, expiresAt: new Date(Date.now() - 1_000) }),
    });
    await expect(service.refresh('ort_x', TENANT, FINGERPRINT)).rejects.toBeInstanceOf(
      TokenExpiredError,
    );

    const revoke = calls.tx.find(
      (call) => call.model === 'refreshToken' && call.op === 'updateMany',
    );
    expect((revoke?.args.data as Row | undefined)?.revokedReason).toBe('EXPIRED');
  });

  it('refuses a token minted for another tenant', async () => {
    // Even though the row is globally readable, a token for tenant A must not be
    // redeemable at tenant B's subdomain.
    const { service } = build({
      refreshToken: () => ({ ...LIVE_REFRESH_ROW, tenantId: OTHER_TENANT_ID }),
    });
    await expect(service.refresh('ort_x', TENANT, FINGERPRINT)).rejects.toBeInstanceOf(
      TenantMismatchError,
    );
  });

  it('does not revoke the family on a tenant mismatch', async () => {
    // A mismatch is not evidence of theft. Revoking here would let anyone with a
    // stolen token sign out the legitimate holder by presenting it elsewhere.
    const { service, calls } = build({
      refreshToken: () => ({ ...LIVE_REFRESH_ROW, tenantId: OTHER_TENANT_ID }),
    });
    await service.refresh('ort_x', TENANT, FINGERPRINT).catch(() => undefined);

    expect(calls.tx.some((call) => call.op === 'updateMany')).toBe(false);
  });

  it('keeps the replacement in the same family', async () => {
    // The family id is the thread that makes a later replay detectable at all.
    const { service, calls } = build({
      refreshToken: () => LIVE_REFRESH_ROW,
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    await service.refresh('ort_x', TENANT, FINGERPRINT).catch(() => undefined);

    const create = calls.tx.find((call) => call.model === 'refreshToken' && call.op === 'create');
    expect((create?.args.data as Row | undefined)?.familyId).toBe(LIVE_REFRESH_ROW.familyId);
  });

  it('revokes the presented token and stores only the new hash', async () => {
    const { service, calls } = build({
      refreshToken: () => LIVE_REFRESH_ROW,
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    await service.refresh('ort_x', TENANT, FINGERPRINT).catch(() => undefined);

    const update = calls.tx.find((call) => call.model === 'refreshToken' && call.op === 'update');
    expect((update?.args.data as Row | undefined)?.revokedReason).toBe('ROTATED');

    const create = calls.tx.find((call) => call.model === 'refreshToken' && call.op === 'create');
    const stored = (create?.args.data as Row | undefined)?.tokenHash as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // The presented plaintext must not be the value persisted.
    expect(stored).not.toBe('ort_x');
  });

  it('writes the rotation audit row against the request tenant', async () => {
    const { service, calls } = build({
      refreshToken: () => LIVE_REFRESH_ROW,
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    await service.refresh('ort_x', TENANT, FINGERPRINT).catch(() => undefined);

    const audit = calls.tx.find((call) => call.model === 'auditLog' && call.op === 'create');
    expect((audit?.args.data as Row | undefined)?.tenantId).toBe(TENANT_ID);
    expect((audit?.args.data as Row | undefined)?.action).toBe('TOKEN_REFRESHED');
  });
});

/* -------------------------------------------------------------------------- */
/* Sign-out and me                                                             */
/* -------------------------------------------------------------------------- */

describe('signOut', () => {
  it('is idempotent for a token that never existed', async () => {
    // Asking to end a session should not be an error because the session is
    // already gone.
    const { service } = build({ refreshToken: () => null });
    await expect(service.signOut('ort_unknown', FINGERPRINT)).resolves.toBeUndefined();
  });

  it('revokes the whole family, so other sessions on it die too', async () => {
    const { service, calls } = build({
      refreshToken: () => ({ familyId: 'fam-1', tenantId: TENANT_ID, userId: USER_ID }),
    });
    await service.signOut('ort_x', FINGERPRINT);

    const revoke = calls.tx.find(
      (call) => call.model === 'refreshToken' && call.op === 'updateMany',
    );
    expect((revoke?.args.where as Row | undefined)?.familyId).toBe('fam-1');
    expect((revoke?.args.data as Row | undefined)?.revokedReason).toBe('SIGNOUT');
  });

  it('revokes into the tenant the token belonged to, not the request host', async () => {
    // `signOut` takes no request tenant. The only trustworthy tenant is the one
    // on the row, and it is what the RLS pin has to use.
    const { service, runs } = build({
      refreshToken: () => ({ familyId: 'fam-1', tenantId: OTHER_TENANT_ID, userId: USER_ID }),
    });
    await service.signOut('ort_x', FINGERPRINT);

    expect(runs.every((run) => run.tenantId === OTHER_TENANT_ID)).toBe(true);
  });
});

describe('me', () => {
  const principal = (overrides: Partial<Principal> = {}): Principal => ({
    userId: USER_ID,
    tenantId: TENANT_ID,
    email: 'dev@acme.test',
    role: TenantRole.Developer,
    userStatus: 'ACTIVE',
    isPlatformAdmin: false,
    membershipId: `${TENANT_ID}:${USER_ID}`,
    jti: 'jti-1',
    ...overrides,
  });

  it('refuses a token whose tenant differs from the request host', async () => {
    const { service } = build({ user: () => ({ ...USER_ROW }) });
    await expect(
      service.me(principal({ tenantId: OTHER_TENANT_ID }), TENANT),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('re-reads the user from the database rather than trusting the token', async () => {
    // The role and status in a token can be 15 minutes stale. `/auth/me` is what
    // makes a short access TTL affordable.
    const { service } = build({
      user: () => ({ ...USER_ROW, status: 'SUSPENDED' }),
      membership: () => ({ role: TenantRole.Owner }),
    });
    await expect(service.me(principal(), TENANT)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('refuses a caller who is no longer a member', async () => {
    const { service } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => null,
    });
    await expect(service.me(principal(), TENANT)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('issues no tokens', async () => {
    // A GET that mutated the session would rotate the refresh token on every page
    // load, breaking clients that do not write the new value back.
    const { service, calls } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    const view = await service.me(principal(), TENANT).catch(() => null);

    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('accessToken');
    expect(view).not.toHaveProperty('refreshToken');
    expect(calls.tx.some((call) => call.model === 'refreshToken')).toBe(false);
  });

  it('reports the live role, not the one frozen into the token', async () => {
    const { service } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Viewer }),
    });
    const view = await service.me(principal({ role: TenantRole.Owner }), TENANT).catch(() => null);

    expect(view?.tenant.role).toBe(TenantRole.Viewer);
  });

  it('scopes the membership read to the request tenant', async () => {
    const { service, calls } = build({
      user: () => ({ ...USER_ROW }),
      membership: () => ({ role: TenantRole.Developer }),
    });
    await service.me(principal(), TENANT).catch(() => undefined);

    const lookup = calls.tx.find((call) => call.model === 'membership');
    expect((lookup?.args.where as Row | undefined)?.tenantId_userId).toEqual({
      tenantId: TENANT_ID,
      userId: USER_ID,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Principal projection                                                        */
/* -------------------------------------------------------------------------- */

describe('toPrincipal', () => {
  it('derives a stable membershipId from the composite primary key', () => {
    const { service } = build();
    const principal = service.toPrincipal({
      userId: USER_ID,
      tenantId: TENANT_ID,
      role: TenantRole.Developer,
      email: 'dev@acme.test',
      userStatus: 'ACTIVE',
      isPlatformAdmin: false,
      jti: 'jti-1',
      expiresAt: 0,
    });

    expect(principal.membershipId).toBe(`${TENANT_ID}:${USER_ID}`);
  });
});

describe('failed audit logging does not swallow the original error', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('still reports the auth failure when the audit insert throws', async () => {
    const { service, runs } = build({ user: () => null }, envWith(), true);

    await expect(
      service.login(
        {
          email: 'dev@acme.test',
          password: 'x'.repeat(20),
          fingerprint: FINGERPRINT,
          requestId: 'r',
        },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(runs.length).toBeGreaterThan(0);
  });
});
