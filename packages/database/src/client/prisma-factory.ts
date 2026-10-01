import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { isTenantScopedModel } from './tenant-models.js';
import { applyTenantScopeToArgs, hasWhere, isRowCountingOperation } from './tenant-args.js';
import {
  TenantScopeError,
  TenantTransactionRequiredError,
  currentTenantScope,
  isRlsEnforced,
  setRlsEnforcement,
} from './tenant-scope.js';

/**
 * Prisma client factory + tenant auto-scoping extension.
 *
 * Three things happen here, in order:
 *
 *  1. A driver adapter is attached. Prisma 7 has no built-in Rust engine, so
 *     `@prisma/adapter-pg` (node-postgres) is the transport. The pool is sized
 *     here rather than left to defaults, because the default is tuned for a
 *     single process and the gateway, the worker and the migrator each open one.
 *
 *  2. A query extension injects the ambient `tenantId` into every read and write
 *     against a tenant-owned model.
 *
 *  3. RLS pinning, via `setRlsTenant`, so Postgres enforces the same rule the
 *     extension does. Enable once the app connects as a non-owner role
 *     (see prisma/rls.sql).
 */

export interface PrismaClientOptions {
  /** Direct connection string. Falls back to `DATABASE_URL`. */
  readonly connectionString?: string | undefined;
  /** Postgres pool size for this process. */
  readonly poolSize?: number | undefined;
  readonly connectionTimeoutSeconds?: number | undefined;
  /** Print every statement. Development only. */
  readonly logQueries?: boolean | undefined;
}

/**
 * Builds the client application code should use: driver adapter attached AND
 * tenant auto-scoping applied.
 *
 * This is the default on purpose. A factory whose name reads like "the Prisma
 * client" but which silently returns an unscoped one is a data-leak waiting to
 * happen, so the safe client is what you get by default and the dangerous one
 * has to be asked for by name — see {@link createRawPrismaClient}.
 */
export function createPrismaClient(options: PrismaClientOptions = {}): PrismaClient {
  return withTenantScope(createRawPrismaClient(options));
}

/**
 * Builds a client WITHOUT tenant auto-scoping.
 *
 * Reserved for: tenant resolution, the seed script, migrations, and
 * platform-admin maintenance. Every call site is a place where a missing
 * `tenantId` filter would return another tenant's rows, so keep the list short
 * and review it like auth code.
 */
/**
 * Detects whether Row Level Security is enforced for the connected role, and
 * records the answer so the query extension can refuse work that RLS would
 * silently turn into an empty result.
 *
 * Call once during bootstrap. `row_security` reports whether policies apply to
 * the current role: `on` for a non-owner role, `off` for the table owner, which
 * is exactly the condition that makes RLS real or inert.
 */
/**
 * Anything that can run a raw query: a full client or a transaction handle.
 * Deliberately narrower than `PrismaClient`, so the probe works on the
 * transaction that actually pins RLS rather than only on a pool connection.
 */
type RawQueryable = Pick<PrismaClient, '$queryRaw'>;

export async function detectRlsEnforcement(client: RawQueryable): Promise<boolean> {
  const rows = await client.$queryRaw<{ row_security: string }[]>`
    SELECT current_setting('row_security') AS row_security
  `;
  const enforced = rows[0]?.row_security === 'on';
  setRlsEnforcement(enforced);
  return enforced;
}

export function createRawPrismaClient(options: PrismaClientOptions = {}): PrismaClient {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env before starting a service.',
    );
  }

  const adapter = new PrismaPg({
    connectionString,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: (options.connectionTimeoutSeconds ?? 10) * 1_000,
  });

  return new PrismaClient({
    adapter,
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });
}

/**
 * Minimal surface needed to pin RLS on a client or transaction handle.
 *
 * The method type is taken from the generated client rather than re-declared, so
 * a Prisma upgrade that changes the signature cannot leave this interface
 * silently out of date — and so transaction handles satisfy it structurally,
 * without a cast at every call site.
 */
export interface RawExecutor {
  $executeRawUnsafe: PrismaClient['$executeRawUnsafe'];
}

/**
 * Sets `app.tenant_id` for the current transaction so the Postgres policies in
 * prisma/rls.sql agree with the client extension.
 *
 * `set_config(..., true)` is transaction-local, so a pooled connection never
 * leaks one tenant's setting into the next request that borrows it.
 */
export async function setRlsTenant(tx: RawExecutor, tenantId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId);
}

/**
 * Applies tenant auto-scoping to a client or transaction handle.
 *
 * Per operation:
 *
 *   findMany / findFirst / count / aggregate / groupBy
 *       -> `where.tenantId = activeTenant`
 *   findUnique / update / delete / upsert
 *       -> `where.tenantId = activeTenant`, and `data.tenantId` on upsert
 *   create       -> `data.tenantId = activeTenant`, rejecting a conflicting value
 *   createMany   -> `data[].tenantId = activeTenant` for every row
 *   updateMany / deleteMany
 *       -> `where.tenantId = activeTenant`
 *
 * With no tenant in scope, a tenant-owned model throws `TenantScopeError`.
 * Silently returning unscoped rows is precisely the bug this design exists to
 * prevent, so it is a hard failure rather than a permissive default. The only
 * exception is a bare count/aggregate with no `where`, which cannot leak rows.
 */
export function withTenantScope<T extends PrismaClient>(client: T): T {
  return client.$extends({
    name: 'orbitoz-tenant-scope',

    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantScopedModel(model)) {
            return query(args);
          }

          const scope = currentTenantScope();

          if (isRlsEnforced() && !scope?.rlsPinned) {
            throw new TenantTransactionRequiredError(model, operation);
          }

          if (!scope || scope.bypassTenantScope) {
            if (isRowCountingOperation(operation) && !hasWhere(args)) {
              return query(args);
            }
            throw new TenantScopeError(
              `Refusing to run ${model}.${operation} without an active tenant scope. ` +
                'Wrap the call in runWithTenant({ tenantId }), or use ' +
                'PrismaService.unscoped() for bootstrap/admin paths.',
            );
          }

          return query(applyTenantScopeToArgs(operation, args, scope.tenantId));
        },
      },
    },
  }) as unknown as T;
}
