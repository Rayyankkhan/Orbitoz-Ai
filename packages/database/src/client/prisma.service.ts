import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client.js';
import {
  createRawPrismaClient,
  detectRlsEnforcement,
  setRlsTenant,
  withTenantScope,
} from './prisma-factory.js';
import type { TenantScopedTransaction } from './tenant-tx.js';
import { runWithTenant } from './tenant-scope.js';
import { PRISMA_OPTIONS, type PrismaClientOptions } from './prisma.tokens.js';

/**
 * The single Prisma instance for a process, with tenant auto-scoping applied.
 *
 * ---------------------------------------------------------------------------
 * CONSUMERS NEVER PASS A TENANT
 * ---------------------------------------------------------------------------
 *
 * // apps/api-gateway/src/modules/conversations/conversations.service.ts
 * @Injectable()
 * export class ConversationsService {
 *   constructor(private readonly prisma: PrismaService) {}
 *
 *   list() {
 *     // No `where: { tenantId }` anywhere. The active tenant is injected by
 *     // the client extension from AsyncLocalStorage, which
 *     // TenantContextInterceptor sets once per request.
 *     return this.prisma.conversation.findMany({ orderBy: { updatedAt: 'desc' } });
 *   }
 * }
 *
 * // apps/worker-service/src/processors/inference.processor.ts
 * await runWithTenant({ tenantId: job.data.tenantId }, async () => {
 *   await this.prisma.inferenceJob.update({ where: { id }, data: { status: 'RUNNING' } });
 * });
 *
 * ---------------------------------------------------------------------------
 * WHY COMPOSITION, NOT `extends PrismaClient`
 * ---------------------------------------------------------------------------
 *
 * Prisma 7 generates `PrismaClient` as an *interface* plus a construct
 * signature, so a subclass cannot express a valid `super()` call — the emitted
 * base-constructor parameter is the options object, not a client instance.
 * Rather than fight it with a cast, this provider composes: it holds the
 * client and re-exposes each model delegate. `this.prisma.inferenceJob.…` reads
 * identically to the subclassed form, but every delegate is statically typed
 * and the extension is impossible to bypass by accident.
 */
/**
 * Sentinel tenant used only to hold a transaction open while RLS posture is
 * probed. It is never written to and matches no real tenant, so even if a
 * concurrent change made the probe write something, RLS would reject it.
 */
const RLS_PROBE_TENANT = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** Client *without* the tenant extension. Only `unscoped()` hands this out. */
  private readonly raw: PrismaClient;

  /** Client *with* the tenant-scoping extension. */
  readonly client: PrismaClient;

  constructor(@Inject(PRISMA_OPTIONS) options: PrismaClientOptions = {}) {
    this.raw = createRawPrismaClient(options);
    this.client = withTenantScope(this.raw);
  }

  /* ---------------------------------------------------------------------- */
  /* Identity — unscoped, must be reachable before a tenant is known         */
  /* ---------------------------------------------------------------------- */

  /** Scoped by the `tenants` RLS policy rather than by the extension. */
  get user(): PrismaClient['user'] {
    return this.client.user;
  }
  get refreshToken(): PrismaClient['refreshToken'] {
    return this.client.refreshToken;
  }
  get providerModel(): PrismaClient['providerModel'] {
    return this.client.providerModel;
  }
  get tenant(): PrismaClient['tenant'] {
    return this.client.tenant;
  }

  /* ---------------------------------------------------------------------- */
  /* Tenant-owned models — every delegate auto-injects the active tenantId   */
  /* ---------------------------------------------------------------------- */

  get membership(): PrismaClient['membership'] {
    return this.client.membership;
  }
  get invitation(): PrismaClient['invitation'] {
    return this.client.invitation;
  }
  get subscription(): PrismaClient['subscription'] {
    return this.client.subscription;
  }
  get apiKey(): PrismaClient['apiKey'] {
    return this.client.apiKey;
  }
  get tenantProvider(): PrismaClient['tenantProvider'] {
    return this.client.tenantProvider;
  }
  get conversation(): PrismaClient['conversation'] {
    return this.client.conversation;
  }
  get inferenceJob(): PrismaClient['inferenceJob'] {
    return this.client.inferenceJob;
  }
  get providerAttempt(): PrismaClient['providerAttempt'] {
    return this.client.providerAttempt;
  }
  get usageRecord(): PrismaClient['usageRecord'] {
    return this.client.usageRecord;
  }
  get usageRollup(): PrismaClient['usageRollup'] {
    return this.client.usageRollup;
  }
  get idempotencyKey(): PrismaClient['idempotencyKey'] {
    return this.client.idempotencyKey;
  }
  get auditLog(): PrismaClient['auditLog'] {
    return this.client.auditLog;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  async onModuleInit(): Promise<void> {
    await this.client.$connect();

    // Verify tenancy is actually enforced before the service accepts traffic.
    //
    // Without this check the failure mode is silent and expensive: with a
    // non-owner role and RLS not applied, every tenant-scoped query returns zero
    // rows, which reads as an empty account rather than a disabled security
    // control. Failing here turns that into a startup error.
    //
    // The check runs in a transaction because `row_security` reflects the
    // current connection, and a pooled client may hand this call a different
    // connection than the next query.
    const enforced = await this.withTenant(RLS_PROBE_TENANT, async (tx) =>
      detectRlsEnforcement(tx),
    ).catch(() => false);

    if (!enforced) {
      throw new Error(
        'Row Level Security is not enforced on this database connection. Verify that ' +
          'the service is connecting as a non-owner role (orbitoz_app) and that ' +
          '`pnpm db:rls` has been applied. Refusing to start.',
      );
    }

    this.logger.log('Prisma connected; Row Level Security verified as enforced');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
    this.logger.log('Prisma disconnected');
  }

  /**
   * Runs `fn` in a transaction with Postgres RLS pinned to `tenantId`, and with
   * the ambient tenant scope active for the whole call tree.
   *
   * Two layers of the same rule, on purpose: the query extension keeps the
   * application honest, RLS makes the database the final authority, so a bug in
   * the first cannot become a data leak. Nest rolls back if `fn` throws.
   *
   * Two non-obvious details:
   *
   *   * An interactive transaction is required, not a stylistic choice. RLS
   *     reads `app.tenant_id` from a session GUC, and the only way to bind that
   *     to one tenant on a pooled connection is `SET LOCAL` inside a
   *     transaction holding a single pinned connection.
   *
   *   * The handle passed to `fn` needs no extra wrapping. `$transaction` on an
   *     extended client hands back delegates that already carry the extension,
   *     so scoping is inherited. Trying to call `withTenantScope(tx)` on it
   *     throws, because Prisma 7 transaction handles expose no `$extends`.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: TenantScopedTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await setRlsTenant(tx, tenantId);
        return runWithTenant({ tenantId, rlsPinned: true }, () =>
          fn(tx as TenantScopedTransaction),
        );
      },
      { maxWait: options?.maxWait ?? 5_000, timeout: options?.timeout ?? 15_000 },
    );
  }

  /** Liveness probe for `/health`. Returns round-trip latency in milliseconds. */
  async ping(): Promise<number> {
    const startedAt = performance.now();
    await this.client.$queryRaw`SELECT 1`;
    return Math.round(performance.now() - startedAt);
  }

  /**
   * Runs `fn` against the client with tenant auto-scoping disabled.
   *
   * Legitimate callers: tenant resolution, the seed script, platform-admin
   * maintenance, and BullMQ workers that carry a tenant but run outside a
   * request. Everything else must use `this` and the ambient scope.
   *
   * Bypasses must state their `where` clause explicitly; the `reason` argument
   * is logged at warn level so the set of bypasses is observable in production.
   */
  unscoped<T>(fn: (client: PrismaClient) => Promise<T>, reason: string): Promise<T> {
    this.logger.warn(`Unscoped Prisma access: ${reason}`);
    return fn(this.raw);
  }
}
