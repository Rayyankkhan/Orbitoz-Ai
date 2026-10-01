/**
 * Per-request database transaction.
 *
 * The gateway resolves the tenant in middleware, before any route handler
 * exists to open a transaction. This service owns the single interactive
 * transaction that spans the request, pinning `app.tenant_id` with SET LOCAL
 * so Postgres applies RLS for its whole duration.
 *
 * Handlers therefore never open their own transaction: nesting one here would
 * use a second pooled connection, which would not have the GUC pinned, and reads
 * would quietly come back empty. `withTenant()` nests correctly because Prisma
 * reuses the ambient transaction client.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService, type TenantScopedTransaction } from '@orbitoz/database';
import { AsyncLocalStorage } from 'node:async_hooks';

export const TENANT_TRANSACTION = Symbol('TENANT_TRANSACTION');

/** The transaction handle for the current request, if one is open. */
const currentTx = new AsyncLocalStorage<TenantScopedTransaction>();

@Injectable()
export class TenantTransaction {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens the request's transaction, pins RLS to `tenant`, and runs `fn`.
   *
   * `fn` must not resolve until the response has been produced. The middleware
   * therefore passes a callback that completes when the pipeline finishes; the
   * connection is held for the request's duration, which is the cost of
   * per-request RLS and is bounded by the pool size.
   */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.withTenant(tenantId, async (tx) => currentTx.run(tx, fn), {
      maxWait: 5_000,
      timeout: 30_000,
    });
  }

  /** The active transaction, for the rare handler that must reach it directly. */
  get active(): TenantScopedTransaction {
    const tx = currentTx.getStore();
    if (!tx) {
      throw new Error(
        'No tenant transaction is active. This route was not reached through ' +
          'TenantMiddleware, so its queries are not covered by Row Level Security.',
      );
    }
    return tx;
  }
}
