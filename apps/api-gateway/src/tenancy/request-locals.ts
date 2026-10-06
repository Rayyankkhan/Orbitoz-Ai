/**
 * Typed readers for the values `TenantMiddleware` attaches to `response.locals`.
 *
 * `response.locals` is `Record<string, any>` in Express's types, so reading
 * `locals.tenant.tenantId` is an unchecked access on an `any` — which defeats the
 * compiler on exactly the value that decides which tenant's rows a request may
 * touch. Every read goes through a narrow cast to the declared shape instead, so
 * a rename of `ResolvedTenant` surfaces as a type error rather than an `undefined`
 * that fails only in production.
 *
 * `RequestIdMiddleware` is why `requestId` is here too: the two middlewares write
 * to the same bag, and one place that knows how to read it is easier to keep
 * correct than four.
 */
import type { Response } from 'express';
import type { ResolvedTenant } from '@orbitoz/shared-types';

/** The tenant `TenantMiddleware` resolved, or `null` when it resolved none. */
export function resolvedTenantOf(response: Response): ResolvedTenant | null {
  return (response.locals?.tenant as ResolvedTenant | undefined) ?? null;
}

/** The request id `RequestIdMiddleware` attached, or `'unknown'`. */
export function requestIdOf(response: Response): string {
  return (response.locals?.requestId as string | undefined) ?? 'unknown';
}
