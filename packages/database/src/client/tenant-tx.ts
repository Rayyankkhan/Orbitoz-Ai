/**
 * Tenant scoping for interactive transaction handles.
 *
 * WHEN YOU NEED THIS
 *
 * Usually you do not. A `$transaction` on an *extended* client already hands
 * back delegates carrying the extension, so `PrismaService.withTenant` passes
 * its handle straight through.
 *
 * This module is for the other case: a transaction opened on a **raw** client
 * (`createRawPrismaClient`), where no extension is present. Prisma 7 transaction
 * handles expose no `$extends` of their own, so a Proxy is the only way to
 * scope them. Both paths delegate to `applyTenantScopeToArgs` so they cannot
 * disagree with each other.
 *
 * WHY A TRANSACTION IS THE RIGHT UNIT HERE
 *
 * RLS reads `app.tenant_id` from a session GUC, and the only reliable way to
 * bind that GUC to one tenant is `SET LOCAL` inside a transaction that holds a
 * single pinned connection. Outside a transaction the setting would have to be
 * session-scoped, which on a pooled connection leaks one tenant's identity into
 * the next request that happens to reuse it.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import { applyTenantScopeToArgs } from './tenant-args.js';
import { TenantScopeError, currentTenantScope } from './tenant-scope.js';
import { isTenantScopedModel } from './tenant-models.js';

/** The PascalCase model names Prisma exposes on a transaction handle. */
const ALL_MODELS = [
  'User',
  'RefreshToken',
  'Tenant',
  'Membership',
  'Invitation',
  'Subscription',
  'ApiKey',
  'ProviderModel',
  'TenantProvider',
  'Conversation',
  'InferenceJob',
  'ProviderAttempt',
  'UsageRecord',
  'UsageRollup',
  'IdempotencyKey',
  'AuditLog',
] as const;

/** Raw SQL passthroughs, copied onto the wrapper so `tx.$queryRaw` still works. */
const RAW_QUERY_METHODS = [
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
] as const;

/**
 * The handle Prisma passes to a `$transaction` callback on an extended client.
 * Its model delegates already carry the tenant extension, so it is safe to use
 * directly; it is only missing the lifecycle methods, which do not exist inside
 * a transaction.
 */
export type TenantScopedTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Wraps an interactive transaction handle so every tenant-owned model is
 * filtered and written with the active tenant.
 *
 * The tenant is captured once, when the wrapper is built, rather than read from
 * the async context on every call. That is deliberate: the wrapper is created
 * inside the scope but used by the caller's async code, which has already left
 * the scope by the time it awaits. Re-reading the context at call time would
 * reject correct code.
 *
 * The handle must already have `app.tenant_id` pinned via `setRlsTenant`;
 * otherwise RLS denies every row and reads quietly return empty. This function
 * scopes the *queries*; the database independently scopes the *rows* it returns.
 * Two independent mechanisms agreeing is the point.
 */
export function createTenantScopedTx(tx: object): TenantScopedTransaction {
  const scope = currentTenantScope();
  if (!scope || scope.bypassTenantScope) {
    throw new TenantScopeError(
      'createTenantScopedTx() requires an active tenant scope. ' +
        'Wrap the transaction in runWithTenant({ tenantId }).',
    );
  }

  const { tenantId } = scope;
  const wrappers = new Map<string, object>();

  for (const modelName of ALL_MODELS) {
    const delegate = (tx as Record<string, Record<string, unknown> | undefined>)[
      lowerFirst(modelName)
    ];
    if (!delegate) continue;

    wrappers.set(
      modelName,
      isTenantScopedModel(modelName) ? scopeDelegate(delegate, tenantId) : delegate,
    );
  }

  // Properties are assigned one by one rather than spread. A Prisma transaction
  // handle is itself a Proxy whose `ownKeys` trap throws if the result set does
  // not include `$on`, so `Object.assign({}, tx)` and `{ ...tx }` both blow up.
  // Enumerating a fixed, known list sidesteps the trap entirely.
  // Object.create returns `any`; the annotation is the boundary, not a claim.
  const handle = Object.create(null) as Record<string, unknown>;
  for (const [modelName, delegate] of wrappers) {
    handle[lowerFirst(modelName)] = delegate;
  }
  for (const key of RAW_QUERY_METHODS) {
    const method: unknown = (tx as Record<string, unknown>)[key];
    if (typeof method === 'function') {
      const call = method as (...args: unknown[]) => unknown;
      handle[key] = call.bind(tx);
    }
  }
  return handle as TenantScopedTransaction;
}

function scopeDelegate(delegate: Record<string, unknown>, tenantId: string): object {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      // Reflect.get is typed `any`; pin it to unknown so the narrow below
      // is the only way a value reaches the caller.
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }
      const operation = property;

      return (...args: unknown[]): unknown => {
        const callArgs: Record<string, unknown> =
          typeof args[0] === 'object' && args[0] !== null
            ? (args[0] as Record<string, unknown>)
            : {};
        return Reflect.apply(value as (...a: unknown[]) => unknown, target, [
          applyTenantScopeToArgs(operation, callArgs, tenantId),
          ...args.slice(1),
        ]);
      };
    },
  });
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
