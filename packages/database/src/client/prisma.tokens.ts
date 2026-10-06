import type { PrismaClientOptions } from './prisma-factory.js';

/** Injection token carrying the resolved {@link PrismaClientOptions}. */
export const PRISMA_OPTIONS = Symbol('PRISMA_OPTIONS');

/**
 * Registry of tables that may have tenant data in *any* database, so a
 * migration can be validated against the live catalog.
 *
 * A *table* list, not a model list, because consumers of this are migrations and
 * operational tooling that read `pg_catalog` and cannot see Prisma's model names.
 * The two cannot be derived from one another automatically, which makes this the
 * one hand-maintained list in the tenancy layer — and a hand-maintained list is
 * exactly the kind that goes stale. So it is checked: `pnpm db:verify` asks the
 * catalog for every table carrying a `tenant_id` column and fails on any this set
 * does not name. Adding a tenant-owned table without adding it here fails that
 * check rather than silently shipping.
 *
 * `approval_requests` is here because it stores a tenant's payload snapshot behind
 * a capability token; a row that held one tenant's prompt and another's job would
 * be a cross-tenant read with no error raised anywhere.
 */
export const TENANT_TABLE_REGISTRY = new Set<string>([
  'memberships',
  'invitations',
  'subscriptions',
  'api_keys',
  'tenant_providers',
  'conversations',
  'inference_jobs',
  'approval_requests',
  'provider_attempts',
  'usage_records',
  'usage_rollups',
  'idempotency_keys',
  'audit_logs',
]);

export type { PrismaClientOptions };
