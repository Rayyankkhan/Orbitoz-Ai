import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient tenant scope.
 *
 * The tenant id is carried in `AsyncLocalStorage` rather than threaded through
 * every function signature. That means a service method three calls deep still
 * issues a correctly scoped query without anyone having to remember to pass the
 * tenant along — which is exactly the mistake that causes cross-tenant leaks.
 *
 * The trade-off: scope is ambient, so it is invisible at the call site. The
 * mitigation is that `PrismaService` *throws* when a tenant-owned model is
 * queried with no scope in context, so an unscoped query fails loudly in
 * development and in tests rather than silently returning another tenant's rows.
 */

export const TENANT_SESSION_VARIABLE = 'app.tenant_id';

export interface TenantScope {
  readonly tenantId: string;
  /** Correlates every statement in the scope with one inbound request. */
  readonly requestId?: string | undefined;
  readonly userId?: string | undefined;
  /**
   * Escape hatch. Set only by platform-admin code paths. When true the
   * auto-scoping extension is skipped, and the caller is responsible for every
   * `where` clause. Every use is expected to be audited.
   */
  readonly bypassTenantScope?: boolean | undefined;
  /**
   * Set by `PrismaService.withTenant` once `app.tenant_id` has been pinned with
   * `SET LOCAL` inside the transaction. See `setRlsEnforcement` for why this
   * matters.
   */
  readonly rlsPinned?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// RLS enforcement mode
//
// A connection whose role is subject to Row Level Security returns ZERO rows
// for a tenant-owned query unless `app.tenant_id` is set, because the policy
// compares against NULL and denies. Query scoping alone is therefore not
// enough on such a connection: an unscoped-by-transaction query comes back empty
// rather than throwing, and "the list is empty" is the kind of bug that ships.
//
// So the deployment states once, at boot, whether its role is RLS-enforced, and
// the extension then refuses to run any tenant-owned query that is not inside a
// pinned transaction. That converts a silent empty result into an error that
// names the fix.
// ---------------------------------------------------------------------------

let rlsEnforced = false;

/** Call once during bootstrap, after checking `row_security` for the role. */
export function setRlsEnforcement(value: boolean): void {
  rlsEnforced = value;
}

export function isRlsEnforced(): boolean {
  return rlsEnforced;
}

export class TenantTransactionRequiredError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refusing to run ${model}.${operation}: this connection enforces Row Level Security, ` +
        'so a query outside a tenant-pinned transaction would return zero rows instead of an ' +
        'error. Run it through PrismaService.withTenant(tenantId, fn), which pins ' +
        'app.tenant_id with SET LOCAL on a dedicated connection.',
    );
    this.name = 'TenantTransactionRequiredError';
  }
}

const storage = new AsyncLocalStorage<TenantScope>();

/**
 * Runs `fn` with `scope` active for the entire async call tree, including
 * across `await`, timers and promise chains.
 *
 * The thenable handling below is load-bearing, not a convenience. ORM clients
 * defer their I/O until `.then()` is called: `prisma.conversation.findMany()`
 * returns a promise that has not touched the database yet. If `fn` returns that
 * promise and the caller awaits it *outside* this function, the query would
 * execute after the context was popped and would be rejected as unscoped —
 * while the surrounding code looks completely correct. Subscribing to the
 * promise here, synchronously inside the scope, is what makes
 *
 *     await runWithTenant({ tenantId }, () => prisma.conversation.findMany())
 *
 * work, and it also makes the equivalent `async () => { await … }` form work.
 */
export function runWithTenant<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, () => {
    const result = fn();
    if (isThenable<T>(result)) {
      return result.then(
        (value) => value,
        (error: unknown) => {
          throw error;
        },
      ) as T;
    }
    return result;
  });
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** The active scope, or `undefined` outside a tenant-scoped call tree. */
export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore();
}

/** The active tenant id. Throws rather than returning `undefined`. */
export function requireTenantId(): string {
  const tenantId = storage.getStore()?.tenantId;
  if (!tenantId) {
    throw new TenantScopeError(
      'No tenant scope is active. Wrap the call in runWithTenant(), or use the ' +
        'explicitly-unscoped client if this is a bootstrap/admin path.',
    );
  }
  return tenantId;
}

/** The active tenant id, or `null` — for optional-tenant flows. */
export function optionalTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}
