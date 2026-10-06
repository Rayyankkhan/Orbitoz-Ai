/**
 * @orbitoz/database — the one place Prisma lives in the monorepo.
 *
 * CONSUMPTION
 *
 *   // apps/api-gateway  and  apps/worker-service  (server only)
 *   import { DatabaseModule, PrismaService, runWithTenant } from '@orbitoz/database';
 *
 *   // apps/web — client components. Type-only or enum-only, never the client.
 *   import { SubscriptionPlan } from '@orbitoz/database/enums';
 *   import type { Tenant } from '@orbitoz/database/types';
 *
 *   // scripts, seed, one-off jobs — explicit, un-annotated client
 *   import { createPrismaClient } from '@orbitoz/database/client';
 *
 * NOTHING re-exports `@prisma/client` or a generated path. Deep imports such as
 * `@orbitoz/database/dist/generated/prisma/client` are blocked by the
 * `exports` map and by the `no-restricted-imports` lint rule, which means
 * "bypass tenant scoping" is a deliberate, reviewable act.
 */

/* ---- Prisma re-exports (server only) ---------------------------------- */
export { Prisma, PrismaClient } from './generated/prisma/client.js';

/* ---- Tenant-aware Nest integration ------------------------------------ */
export { PrismaService } from './client/prisma.service.js';
export { DatabaseModule } from './client/prisma.module.js';
export { PRISMA_OPTIONS, TENANT_TABLE_REGISTRY } from './client/prisma.tokens.js';

/* ---- Explicit client construction (scripts, workers, tests) ----------- */
export {
  createPrismaClient,
  createRawPrismaClient,
  detectRlsEnforcement,
  withTenantScope,
  setRlsTenant,
} from './client/prisma-factory.js';
export type { PrismaClientOptions } from './client/prisma-factory.js';

/* ---- Tenant scoping --------------------------------------------------- */
export {
  runWithTenant,
  currentTenantScope,
  requireTenantId,
  optionalTenantId,
  setRlsEnforcement,
  isRlsEnforced,
  TenantScopeError,
  TenantTransactionRequiredError,
  TENANT_SESSION_VARIABLE,
} from './client/tenant-scope.js';
export type { TenantScope } from './client/tenant-scope.js';
export {
  TENANT_SCOPED_MODELS,
  GLOBAL_MODELS,
  isTenantScopedModel,
  unclassifiedModels,
} from './client/tenant-models.js';
export { createTenantScopedTx, type TenantScopedTransaction } from './client/tenant-tx.js';
export { applyTenantScopeToArgs } from './client/tenant-args.js';
