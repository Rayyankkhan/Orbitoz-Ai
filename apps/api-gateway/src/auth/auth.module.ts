/**
 * Auth module wiring.
 *
 * ---------------------------------------------------------------------------
 * ROUTING TABLE — WHICH ROUTES SKIP TENANT RESOLUTION
 * ---------------------------------------------------------------------------
 * `TenantMiddleware` normally resolves a tenant from the request `Host` before
 * any handler runs, and refuses the request with a 404 when it cannot. Four of
 * the five auth routes need that; registration cannot have it:
 *
 *   POST /auth/register  Excluded from the middleware. A signup arrives before
 *                        any tenant exists, so no host resolves and there is no
 *                        tenant to scope a transaction to. The service opens its
 *                        own transaction and pins `app.tenant_id` to the tenant it
 *                        has just created. This is the only route in the gateway
 *                        that reaches the database with no tenant in scope, and
 *                        `rls_tenants_insert` is keyed on `app_tenant_unset()` so
 *                        the database enforces even that.
 *
 *   GET  /health         Excluded in `app.module.ts` instead, since it is not an
 *                        auth route.
 *
 *   POST /auth/login     Tenant-resolved. Sign-in is a decision *about a tenant*:
 *   POST /auth/refresh          an account may exist on several, and the
 *   GET  /auth/me               membership that gets checked is the one for this
 *   POST /auth/logout           host. `/auth/logout` is `@Public` rather than
 *                        guarded — a client whose access token has expired must
 *                        still be able to end its session.
 *
 * ---------------------------------------------------------------------------
 * WHY `JwtAuthGuard` IS AN APP_GUARD AND NOT A CONTROLLER MIXIN
 * ---------------------------------------------------------------------------
 * A guard registered globally has no route to be forgotten on. `@UseGuards` on a
 * base class, or on individual handlers, share one failure mode: a new
 * controller in a new folder is simply unprotected, and nothing complains until
 * someone reviews the route list. Here the default is deny and `@Public()` is
 * the explicit opt-out, so the mistake is an unreachable endpoint rather than an
 * exposed one.
 */
import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { TenantMiddleware } from '../tenancy/tenant.middleware.js';
import { EnvService } from '../config/env.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [TenancyModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      // Built from already-validated configuration rather than reading
      // `process.env` here, so every secret is handled in exactly one place.
      provide: TokenService,
      useFactory: (env: EnvService): TokenService =>
        new TokenService({
          accessSecret: env.value.auth.accessSecret,
          refreshSecret: env.value.auth.refreshSecret,
          accessTtlSeconds: env.value.auth.accessTtlSeconds,
          issuer: env.value.auth.issuer,
          audience: env.value.auth.audience,
          clockToleranceSeconds: env.value.auth.clockToleranceSeconds,
        }),
      inject: [EnvService],
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule implements NestModule {
  /**
   * Scopes the middleware to auth routes, minus registration.
   *
   * Paths are relative to the global prefix, matching how `health` is excluded in
   * `app.module.ts`. Nest applies `exclude` before the middleware runs, so a
   * request to `auth/register` never reaches `TenantMiddleware` and therefore
   * never inherits an ambient scope — which is exactly right, because the
   * transaction inside `registerTenant` establishes its own.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantMiddleware)
      .exclude({ path: 'auth/register', method: RequestMethod.POST })
      .forRoutes('auth/*');
  }
}
