/**
 * Route metadata for authentication and authorization.
 *
 * Set with Nest's `SetMetadata` rather than inferred from a controller's location
 * in the module graph, because "is this route public?" has to be readable at the
 * route, not derivable from a folder name. A guard that defaults to *deny* and
 * is switched off explicitly per route means a new controller is protected by
 * omission — the failure mode is an inaccessible route, never an unprotected
 * one.
 */
import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { TenantRole } from '@orbitoz/shared-types';
import type { Principal } from './auth.types.js';
import { resolvedTenantOf } from '../tenancy/request-locals.js';

/**
 * The authenticated caller, as attached to `request.auth`.
 *
 * Present on every non-public route. Throws rather than returning undefined: a
 * handler that asked for the caller on a route where none exists is a wiring
 * mistake, and finding out at request time with a clear message beats a
 * property access on `undefined` three frames deeper.
 */
export interface AuthenticatedRequest extends Request {
  auth?: Principal;
}

/** Opts a route out of `JwtAuthGuard`. */
export const IS_PUBLIC_KEY = 'orbitoz:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restricts a route to specific roles.
 *
 * Checked against the *token's* role, which is the cheapest correct check, and
 * backed by the `/auth/me` re-read that keeps the stored role fresh. A role
 * revoked mid-session therefore stops working at the next request rather than
 * when the access token expires.
 */
export const ROLES_KEY = 'orbitoz:roles';
export const Roles = (...roles: readonly TenantRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Injects the authenticated caller.
 *
 * Usage: `@CurrentUser() auth: Principal`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.auth;
    if (!principal) {
      throw new Error(
        '@CurrentUser() was used on a route that is not authenticated. Either remove the ' +
          '@Public() decorator from the route, or stop reading the caller there.',
      );
    }
    return principal;
  },
);

/**
 * Injects the tenant resolved from the request host.
 *
 * Populated by `TenantMiddleware`. Never read from the request body or a query
 * parameter — a client-supplied tenant id is a hint, never an identity. See
 * `docs/architecture/multi-tenancy.md`.
 */
export const CurrentTenantId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const response = context.switchToHttp().getResponse<Response>();
    const tenantId = resolvedTenantOf(response)?.tenantId;
    if (!tenantId) {
      throw new Error(
        'No tenant is resolved for this request. The route was not reached through ' +
          'TenantMiddleware, so its queries would not be covered by Row Level Security.',
      );
    }
    return tenantId;
  },
);
