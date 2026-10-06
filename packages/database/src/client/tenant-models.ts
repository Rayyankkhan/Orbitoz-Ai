/**
 * Which models carry tenant data, and which deliberately do not.
 *
 * This is the single most important list in the codebase. Every model in
 * `schema.prisma` is in exactly one bucket:
 *
 *   TENANT_SCOPED_MODELS — has a `tenantId` column. The extension injects the
 *                          active tenant into every read and write, so handlers
 *                          never pass `tenantId` themselves.
 *
 *   GLOBAL_MODELS        — no tenancy: the identity and reference tables that
 *                          must be readable *before* a tenant is known, or that
 *                          are shared reference data. The extension never
 *                          touches these; querying one is an explicit,
 *                          greppable decision.
 *
 * ---------------------------------------------------------------------------
 * THE NAMES ARE PASSTHROUGH FROM PRISMA, NOT FROM THE SCHEMA FILE
 * ---------------------------------------------------------------------------
 *
 * These are Prisma's DMMF model names, which are the model names as written in
 * schema.prisma — PascalCase. They are NOT the camelCase client property names
 * (`prisma.conversation`), which is an easy mistake to make and a dangerous
 * one: a key that does not match makes the extension skip the model entirely,
 * so every query runs unscoped and looks like it works.
 *
 * `pnpm --filter @orbitoz/database verify:tenancy` asserts that every model
 * in the schema is classified, so a new model cannot be added to the schema
 * without being placed in one of these two sets.
 */

/** Models the extension injects `tenantId` into. */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Membership',
  'Invitation',
  'Subscription',
  'ApiKey',
  'TenantProvider',
  'Conversation',
  'InferenceJob',
  'ProviderAttempt',
  'UsageRecord',
  'UsageRollup',
  'IdempotencyKey',
  'AuditLog',
  'ApprovalRequest',
]);

/** Models the extension must never touch. */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set([
  // Resolved before a tenant exists: sign-in looks a user up by email.
  'User',
  // Resolved by token hash during refresh, before a tenant is known.
  'RefreshToken',
  // Shared reference data: the model catalogue every tenant reads from.
  'ProviderModel',
  // Tenant resolution itself looks a tenant up by slug or custom domain.
  // Scoped at the database level by the `tenants` RLS policy instead.
  'Tenant',
]);

export function isTenantScopedModel(model: string): boolean {
  return TENANT_SCOPED_MODELS.has(model);
}

/** @internal Guards the two sets against drift. Used by the tenancy check. */
export function unclassifiedModels(allModelNames: readonly string[]): string[] {
  const known = new Set([...TENANT_SCOPED_MODELS, ...GLOBAL_MODELS]);
  return allModelNames.filter((name) => !known.has(name));
}
