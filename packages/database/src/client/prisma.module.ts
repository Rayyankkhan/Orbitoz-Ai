import { Global, Module, type DynamicModule } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { PRISMA_OPTIONS, type PrismaClientOptions } from './prisma.tokens.js';

/**
 * Global module exposing a single, tenant-scoped `PrismaService`.
 *
 * `@Global()` because the alternative is importing `DatabaseModule` into every
 * feature module, which is noise — there is exactly one pool per process and
 * it should be un-ambiguous where it lives.
 *
 * `forRoot` returns a `DynamicModule` so each service can size its own pool:
 * the gateway is I/O bound and the worker holds long transactions, so they do
 * not want the same `max`.
 *
 *   // apps/api-gateway/src/app.module.ts
 *   imports: [
 *     DatabaseModule.forRoot({
 *       connectionString: config.getOrThrow('DATABASE_URL'),
 *       poolSize: 20,
 *       logQueries: config.get('NODE_ENV') === 'development',
 *     }),
 *   ]
 *
 * // apps/worker-service/src/app.module.ts
 *   imports: [DatabaseModule.forRoot({ poolSize: 5, enableRls: true })]
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: PrismaClientOptions = {}): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [{ provide: PRISMA_OPTIONS, useValue: options }, PrismaService],
      exports: [PrismaService],
    };
  }

  /**
   * Empty configuration, for tests and one-off scripts that build their own
   * client via `createPrismaClient()`.
   */
  static forRootAsync(): DynamicModule {
    return { module: DatabaseModule, global: true };
  }
}
