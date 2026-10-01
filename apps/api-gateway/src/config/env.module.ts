import { Global, Module } from '@nestjs/common';
import { EnvService } from './env.service.js';

/**
 * Global so that every feature module can inject `EnvService` without importing
 * this module. There is exactly one source of configuration per process, and
 * making it ambient removes a category of import churn.
 */
@Global()
@Module({
  providers: [EnvService],
  exports: [EnvService],
})
export class EnvModule {}
