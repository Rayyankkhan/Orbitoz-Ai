/**
 * The worker's database handle.
 *
 * Mirrors `PrismaService.withTenant` from the gateway, because a worker cannot
 * use that: it is a Nest `Injectable` that expects a long-lived process-wide
 * client, and a worker has no request to inherit a transaction from.
 *
 * The contract is identical and that is the point — both open an interactive
 * transaction, pin `app.tenant_id` with `SET LOCAL`, and establish the ambient
 * scope *inside* it. Two implementations of one rule, because the two processes
 * genuinely have different lifetimes, but not two different rules about what a
 * scoped query requires.
 */
import { Logger } from '@nestjs/common';
import {
  createPrismaClient,
  detectRlsEnforcement,
  isRlsEnforced,
  runWithTenant,
  setRlsEnforcement,
  setRlsTenant,
  type PrismaClient,
  type TenantScopedTransaction,
} from '@orbitoz/database';

export class WorkerDatabase {
  private readonly logger = new Logger(WorkerDatabase.name);
  private readonly client: PrismaClient;

  constructor(connectionString: string) {
    this.client = createPrismaClient({ connectionString });
  }

  /**
   * Verifies that RLS is actually enforced for the connected role.
   *
   * Called once at boot for the same reason the gateway does it: connected as an
   * owner role, every tenant-scoped query returns zero rows and nothing looks
   * broken. Failing at startup turns a silent data-availability bug into a
   * visible startup failure.
   *
   * @throws when the role bypasses Row Level Security.
   */
  async assertRlsEnforced(): Promise<void> {
    const enforced = await detectRlsEnforcement(this.client);
    setRlsEnforcement(enforced);

    if (!enforced) {
      throw new Error(
        'Connected database role does not enforce Row Level Security. Worker tenant isolation ' +
          'depends on it — application code cannot substitute for a policy that is not applied. ' +
          'Check DATABASE_URL points at the non-owner role, not DIRECT_DATABASE_URL.',
      );
    }
    this.logger.log('Row Level Security is enforced for the worker connection');
  }

  /** Whether RLS enforcement has been detected and is on. */
  get rlsEnforced(): boolean {
    return isRlsEnforced();
  }

  /**
   * Runs `fn` inside a transaction pinned to `tenantId`.
   *
   * The scope is established *inside* the transaction callback, after
   * `set_config`, so the ambient scope and the GUC can never disagree. Reversing
   * that order would let a query observe a scope the database is not enforcing.
   *
   * `maxWait`/`timeout` are lower than the gateway's: a worker's work is
   * short-lived and independent, so a job that cannot get a connection promptly
   * should fail and retry rather than queue behind other jobs. The default
   * interactive-transaction timeout is 5s, which is short enough that a wedged
   * query would otherwise hold the connection for the rest of the job's retries.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: TenantScopedTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await setRlsTenant(tx, tenantId);
        // `rlsPinned: true` is what satisfies the client extension's check that a
        // tenant-owned query is backed by a transaction the database is enforcing
        // against. Without it, every query here throws rather than returning rows.
        return runWithTenant({ tenantId, rlsPinned: true }, () =>
          fn(tx as TenantScopedTransaction),
        );
      },
      { maxWait: options?.maxWait ?? 2_000, timeout: options?.timeout ?? 10_000 },
    );
  }

  /**
   * Runs `fn` with tenant auto-scoping disabled.
   *
   * Reserved for paths that legitimately precede a tenant being known. Every use
   * takes a `reason` that is logged at warn level, so the bypasses are visible in
   * production rather than discoverable only by reading the source.
   */
  async unscoped<T>(fn: (client: PrismaClient) => Promise<T>, reason: string): Promise<T> {
    this.logger.warn(`Unscoped Prisma access in worker: ${reason}`);
    return fn(this.client);
  }

  /** Closes the pool. Called during shutdown. */
  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }
}
