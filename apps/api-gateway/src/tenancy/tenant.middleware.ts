/**
 * Resolves the tenant for every request and publishes it as ambient scope.
 *
 * This middleware deliberately does NOT open a database transaction, and the
 * reason is worth stating because the intuitive design is wrong here.
 *
 * `next()` returns as soon as the pipeline is handed off — before the route
 * handler has awaited anything. A transaction opened around a callback that
 * merely calls `next()` therefore commits the instant the middleware returns,
 * which is before the handler has run its first query. Handlers would then read
 * through a committed, unpinned connection and Postgres, honouring RLS, would
 * return nothing. It fails silently, and only under a non-owner role.
 *
 * AsyncLocalStorage does not have this problem, because context propagates to
 * async work *started* inside the scope. Calling `next()` inside `runWithTenant`
 * is enough for the handler's continuations to inherit the tenant.
 *
 * So the split is:
 *   - middleware  publishes *which tenant* this request is for
 *   - `TenantTransaction.run()` opens the transaction that RLS is pinned in
 *
 * With enforcement detected (see main.ts), a handler that queries tenant data
 * without going through `TenantTransaction` gets a clear error instead of an
 * empty result set.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response } from 'express';
import { asRequestId } from '@orbitoz/shared-types';
import { runWithTenant } from '@orbitoz/database';
import { TenantResolver } from './tenant.resolver.js';
import { EnvService } from '../config/env.service.js';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly resolver: TenantResolver,
    private readonly env: EnvService,
  ) {}

  async use(request: Request, response: Response, next: (error?: unknown) => void): Promise<void> {
    const requestId = asRequestId(randomUUID());
    response.locals.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    const tenant = await this.resolver.resolveFromRequest(request);

    if (!tenant) {
      if (this.env.tenantRequired) {
        response.status(404).json({
          error: 'tenant_not_found',
          message: 'No tenant matches this host.',
          requestId,
        });
        return;
      }
      // Single-tenant mode: no tenant on the host, so no tenant-owned data may be
      // read or written. Handlers still run; they just have no tenant to use.
      next();
      return;
    }

    response.locals.tenant = tenant;
    response.setHeader('x-tenant-id', tenant.tenantId);

    // rlsPinned is false: nothing is pinned yet. It becomes true inside the
    // transaction that actually holds the GUC.
    runWithTenant({ tenantId: tenant.tenantId, requestId, rlsPinned: false }, () => next());
  }
}
