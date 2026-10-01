import { Module } from '@nestjs/common';
import { TenantMiddleware } from './tenant.middleware.js';
import { TenantResolver } from './tenant.resolver.js';
import { TENANT_TRANSACTION, TenantTransaction } from './tenant-transaction.js';

/**
 * Everything that has to happen before a request reaches a route handler.
 *
 * `TenantMiddleware` is a provider rather than an `APP_GUARD` on purpose: it
 * has to own a database transaction, and guards run before interceptors and
 * middleware resolution, which is the wrong place for a resource that lives for
 * the whole request.
 */
@Module({
  providers: [
    TenantResolver,
    TenantMiddleware,
    { provide: TENANT_TRANSACTION, useExisting: TenantTransaction },
    TenantTransaction,
  ],
  exports: [TENANT_TRANSACTION],
})
export class TenancyModule {}
