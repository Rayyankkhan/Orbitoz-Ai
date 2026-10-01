import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { DatabaseModule } from '@orbitoz/database';
import { EnvModule } from './config/env.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';
import { HealthController } from './database/health.controller.js';

@Module({
  imports: [
    EnvModule,
    // No options: the factory reads DATABASE_URL, which already points at the
    // unprivileged application role. See prisma/roles.sql.
    DatabaseModule.forRoot(),
    TenancyModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to everything except /health, which has no tenant to resolve and
    // must stay reachable when DNS is broken.
    consumer
      .apply(TenantMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
