import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { DatabaseModule } from '@orbitoz/database';
import { EnvModule } from './config/env.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';
import { HealthController } from './database/health.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { ApprovalModule } from './approvals/approval.module.js';

@Module({
  imports: [
    EnvModule,
    // No options: the factory reads DATABASE_URL, which already points at the
    // unprivileged application role. See prisma/roles.sql.
    DatabaseModule.forRoot(),
    TenancyModule,
    // Registers `JwtAuthGuard` as an APP_GUARD, so it applies to every route
    // in the application — including controllers added later.
    AuthModule,
    // Human-in-the-loop approvals. Its routes need no middleware of their own:
    // the `TenantMiddleware` below already resolves a tenant for `*`, and the
    // token lookup depends on that.
    ApprovalModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to everything except /health, which has no tenant to resolve and
    // must stay reachable when DNS is broken.
    //
    // Auth routes are handled by AuthModule's own `configure`, which excludes
    // POST /auth/register. That route has to bypass tenant resolution: a signup
    // arrives before any tenant exists.
    consumer
      .apply(TenantMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
