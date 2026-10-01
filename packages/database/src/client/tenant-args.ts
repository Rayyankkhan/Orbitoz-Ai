/**
 * The single implementation of "add the active tenant to this query".
 *
 * Two callers need it:
 *
 *   1. The Prisma query extension, for ordinary clients.
 *   2. `createTenantScopedTx`, for interactive transaction handles.
 *
 * They must agree exactly. If the extension scoped `create` one way and the
 * transaction wrapper another, code would pass in tests and leak in production
 * depending on which connection it happened to run on — the worst possible
 * failure mode, because it is invisible until it matters. Hence one module.
 *
 * All functions here are pure: they return a new args object and never mutate
 * the caller's.
 */
import { TenantScopeError } from './tenant-scope.js';

/** Operations that read rows and therefore need a `where.tenantId`. */
const FILTERED_READS_OR_WRITES: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/**
 * Returns a copy of `args` scoped to `tenantId`, according to `operation`.
 *
 * Throws `TenantScopeError` if the caller supplied a conflicting `tenantId`,
 * because a write naming another tenant is a bug or an attack and must fail
 * here rather than deep inside Postgres with a message that does not name the
 * offending field.
 */
export function applyTenantScopeToArgs(
  operation: string,
  args: unknown,
  tenantId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(args as Record<string, unknown>) };

  switch (operation) {
    case 'create': {
      const data = (next.data ?? {}) as Record<string, unknown>;
      assertNoTenantOverride('create', data, tenantId);
      // Rebuilding `data` is not incidental: it is what makes Prisma select the
      // UncheckedCreateInput variant. Forwarding the original args untouched
      // makes it fall back to CreateInput, which demands the `tenant` relation
      // and fails validation. See docs/architecture/multi-tenancy.md.
      next.data = { ...data, tenantId };
      break;
    }

    case 'createMany': {
      const rows = next.data;
      if (!Array.isArray(rows)) {
        throw new TenantScopeError('createMany.data must be an array; cannot apply tenant scope.');
      }
      next.data = rows.map((row: unknown) => {
        const record = row as Record<string, unknown>;
        assertNoTenantOverride('createMany', record, tenantId);
        return { ...record, tenantId };
      });
      break;
    }

    case 'createManyAndReturn': {
      const rows = next.data;
      if (!Array.isArray(rows)) {
        throw new TenantScopeError(
          'createManyAndReturn.data must be an array; cannot apply tenant scope.',
        );
      }
      next.data = rows.map((row: unknown) => {
        const record = row as Record<string, unknown>;
        assertNoTenantOverride('createManyAndReturn', record, tenantId);
        return { ...record, tenantId };
      });
      break;
    }

    case 'upsert': {
      // Both halves are scoped: the lookup must not match another tenant's row,
      // the insert must not create one here, and the update must not reach one.
      const create = (next.create ?? next.data ?? {}) as Record<string, unknown>;
      const update = (next.update ?? {}) as Record<string, unknown>;
      assertNoTenantOverride('upsert', create, tenantId);
      assertNoTenantOverride('upsert', update, tenantId);
      next.where = scopedWhere(next.where, tenantId, operation);
      next.create = { ...create, tenantId };
      next.update = { ...update, tenantId };
      break;
    }

    default: {
      if (FILTERED_READS_OR_WRITES.has(operation)) {
        next.where = scopedWhere(next.where, tenantId, operation);
        break;
      }
      // count / aggregate / groupBy and anything a future Prisma release adds.
      // Inject only when a `where` is already present, so a bare count is left
      // alone rather than being rewritten into a different query shape.
      const where = next.where;
      if (where) next.where = { tenantId, ...where };
      break;
    }
  }

  return next;
}

export function isRowCountingOperation(operation: string): boolean {
  return operation === 'count' || operation === 'aggregate' || operation === 'groupBy';
}

export function hasWhere(args: unknown): boolean {
  return (
    typeof args === 'object' &&
    args !== null &&
    'where' in args &&
    (args as { where?: unknown }).where !== undefined
  );
}

/**
 * Returns `where` with the active tenant applied.
 *
 * The injected `tenantId` is spread *last* on purpose. Spreading it first lets a
 * caller's own `tenantId` silently win, which turns the query into a read of
 * whichever tenant the caller named. Under RLS that returns nothing at all
 * rather than raising, so the mistake looks like an empty result; on any
 * connection where RLS does not apply it is a cross-tenant read.
 *
 * A conflicting value is therefore rejected instead of quietly overwritten —
 * naming another tenant is a bug or an attack either way, and both deserve to
 * fail at the call site.
 */
function scopedWhere(
  existing: unknown,
  tenantId: string,
  operation: string,
): Record<string, unknown> {
  const where = (existing ?? {}) as Record<string, unknown>;
  assertNoTenantOverride(operation, where, tenantId);
  return { ...where, tenantId };
}

function assertNoTenantOverride(
  operation: string,
  data: Record<string, unknown>,
  tenantId: string,
): void {
  const provided = data.tenantId;
  if (provided !== undefined && provided !== tenantId) {
    // `provided` is `unknown` here, so String() could render an object as
    // "[object Object]" and hide the offending value. JSON.stringify keeps the
    // message diagnosable without assuming a type the caller may not honour.
    const shown = typeof provided === 'string' ? provided : JSON.stringify(provided);
    throw new TenantScopeError(
      `${operation} was given tenantId=${shown} but the active scope is ` +
        `${tenantId}. Cross-tenant writes are rejected.`,
    );
  }
}
