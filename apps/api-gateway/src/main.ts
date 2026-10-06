/**
 * Process entry point.
 *
 * Bootstrap order matters: configuration is validated before anything is
 * constructed, and the database is verified before the port is opened, so a
 * misconfigured or unreachable dependency fails the deploy rather than
 * accepting traffic it cannot serve.
 */
import 'reflect-metadata';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { AuthErrorFilter } from './auth/auth-error.filter.js';

async function main(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.use(helmet());
  app.setGlobalPrefix(env.apiGateway.globalPrefix);
  app.enableCors({
    origin: env.apiGateway.corsOrigins,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });
  app.useGlobalFilters(new HttpExceptionFilter(), new AuthErrorFilter());
  // Nest's shutdown hooks let in-flight requests finish before the process
  // exits, so a deploy does not cut off an in-flight inference request.
  app.enableShutdownHooks();

  await app.listen(env.apiGateway.port, '0.0.0.0');
  logger.log(`API gateway listening on :${env.apiGateway.port}/${env.apiGateway.globalPrefix}`);
}

await main();
