import type { PrismaClientOptions } from './prisma-factory.js';

/** Injection token carrying the resolved {@link PrismaClientOptions}. */
export const PRISMA_OPTIONS = Symbol('PRISMA_OPTIONS');

/**
 * Registry of tables that may have tenant data in *any* database, so a
 * migration can be validated against the live catalog. Filled in by
 * `PrismaService.onModuleInit()`.
 */
export const TENANT_TABLE_REGISTRY = new Set<string>([
  'memberships',
  'invitations',
  'subscriptions',
  'api_keys',
  'tenant_providers',
  'conversations',
  'inference_jobs',
  'provider_attempts',
  'usage_records',
  'usage_rollups',
  'idempotency_keys',
  'audit_logs',
]);

export type { PrismaClientOptions };
