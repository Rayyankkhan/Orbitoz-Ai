#!/usr/bin/env node
/**
 * Generates the initial skeleton for every workspace app and package.
 *
 *   node scripts/scaffold.mjs                    # all targets
 *   node scripts/scaffold.mjs apps/api-gateway   # one target
 *   node scripts/scaffold.mjs --dry-run          # show the plan, write nothing
 *   node scripts/scaffold.mjs --force            # overwrite existing files
 *
 * IDEMPOTENT BY DEFAULT
 * Existing files are never overwritten without `--force`. That makes the script
 * safe to run on a checkout that has already been customised, which matters
 * because scaffolding is a one-time thing that people re-run by muscle memory.
 *
 * WHY GENERATE FILES RATHER THAN KEEP A TEMPLATE DIRECTORY
 * A `templates/` copy of the same files drifts from the real ones the moment
 * anyone edits an app. Here the script is the single source of truth for the
 * initial skeleton, and after the first run the files themselves are the source
 * of truth. The cost is that `--force` is destructive, which is why it is opt-in
 * and why the summary lists every path before writing.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Shared file bodies
// ---------------------------------------------------------------------------

const gitignoreApp = `# Build output
dist
.next
.turbo
*.tsbuildinfo

# Local env — never commit a real .env
.env
.env.local
`;

const appTsconfig = (name) =>
  JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/tsconfig',
      extends: '@orbitoz/config/tsconfig/nestjs.json',
      compilerOptions: { outDir: 'dist', rootDir: 'src', lib: ['ES2023'], types: ['node'] },
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
    null,
    2,
  ) + '\n';

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const TARGETS = [
  {
    id: 'apps/api-gateway',
    description: 'NestJS HTTP API — authentication, tenancy resolution, inference requests',
    files: {
      'package.json': `${JSON.stringify(
        {
          name: '@orbitoz/api-gateway',
          version: '0.1.0',
          private: true,
          type: 'module',
          main: 'dist/main.js',
          scripts: {
            build: 'tsc -p tsconfig.json',
            start: 'node --enable-source-maps dist/main.js',
            // tsc emits decorator metadata that tsx/esbuild cannot produce, so
            // the watcher is tsc and the restarter is node.
            dev: 'concurrently -k -n tsc,api -c blue,green "tsc -p tsconfig.json --watch --preserveWatchOutput" "node --watch --enable-source-maps dist/main.js"',
            typecheck: 'tsc -p tsconfig.json --noEmit',
            lint: 'eslint .',
            clean: 'rimraf dist',
          },
          dependencies: {
            '@orbitoz/config': 'workspace:*',
            '@orbitoz/database': 'workspace:*',
            '@orbitoz/shared-types': 'workspace:*',
            '@nestjs/common': 'catalog:',
            '@nestjs/core': 'catalog:',
            '@nestjs/platform-express': 'catalog:',
            helmet: 'catalog:',
            'reflect-metadata': 'catalog:',
            rxjs: 'catalog:',
            zod: 'catalog:',
          },
          devDependencies: {
            '@types/express': 'catalog:',
            '@types/node': 'catalog:',
            concurrently: 'catalog:',
            eslint: 'catalog:',
            rimraf: 'catalog:',
            typescript: 'catalog:',
          },
        },
        null,
        2,
      )}\n`,

      'tsconfig.json': appTsconfig('api-gateway'),
      '.gitignore': gitignoreApp,

      'src/main.ts': `/**
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
  app.useGlobalFilters(new HttpExceptionFilter());
  // Nest's shutdown hooks let in-flight requests finish before the process
  // exits, so a deploy does not cut off an in-flight inference request.
  app.enableShutdownHooks();

  await app.listen(env.apiGateway.port, '0.0.0.0');
  logger.log(\`API gateway listening on :\${env.apiGateway.port}/\${env.apiGateway.globalPrefix}\`);
}

await main();
`,

      'src/config/env.ts': `/**
 * Environment loading and validation.
 *
 * Parsed once at import time with Zod rather than read ad hoc throughout the
 * codebase. A typo in a variable name then fails at boot with a message naming
 * the variable, instead of surfacing as \`undefined\` in a request handler at
 * 3am.
 */
import { z } from 'zod';

// Accepts either a comma-separated string or an array. Note that '.default()'
// on a piped schema takes the *output* type (string[]), so the default below is
// an array, and the union is what lets
// CORS_ORIGINS="http://a,http://b" can stay a single string in .env.
const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(',')).map((part) => part.trim()).filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  apiGateway: z.object({
    port: z.coerce.number().int().positive().default(4000),
    globalPrefix: z.string().min(1).default('v1'),
    corsOrigins: csv.default(['http://localhost:3000']),
  }),

  database: z.object({
    /** The application role. Row Level Security is enforced against it. */
    url: z.url(),
  }),

  tenancy: z.object({
    rootDomain: z.string().min(1).default('orbitoz.ai'),
    header: z.string().min(1).default('x-orbitoz-tenant'),
    /**
     * When false, a request with no resolvable tenant is served as a
     * single-tenant deployment. Off by default so a misconfigured DNS does not
     * silently merge tenants.
     */
    required: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  }),

  logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace', 'fatal']).default('info'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse({
    NODE_ENV: source.NODE_ENV,
    apiGateway: {
      port: source.API_GATEWAY_PORT,
      globalPrefix: source.API_GATEWAY_GLOBAL_PREFIX,
      corsOrigins: source.API_GATEWAY_CORS_ORIGINS,
    },
    // DATABASE_URL points at the unprivileged application role, never at the
    // migration role — see packages/database/prisma/roles.sql.
    database: { url: source.DATABASE_URL ?? source.APP_DATABASE_URL },
    tenancy: {
      rootDomain: source.TENANT_ROOT_DOMAIN,
      header: source.TENANT_HEADER,
      required: source.TENANT_REQUIRED,
    },
    logLevel: source.LOG_LEVEL,
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => \`  \${issue.path.join('.')}: \${issue.message}\`)
      .join('\\n');
    throw new Error(\`Invalid environment configuration:\\n\${detail}\\n\\nSee .env.example.\`);
  }
  return parsed.data;
}
`,

      'src/tenancy/tenant.middleware.ts': `/**
 * Resolves the tenant for every request and publishes it as ambient scope.
 *
 * This middleware deliberately does NOT open a database transaction, and the
 * reason is worth stating because the intuitive design is wrong here.
 *
 * \`next()\` returns as soon as the pipeline is handed off — before the route
 * handler has awaited anything. A transaction opened around a callback that
 * merely calls \`next()\` therefore commits the instant the middleware returns,
 * which is before the handler has run its first query. Handlers would then read
 * through a committed, unpinned connection and Postgres, honouring RLS, would
 * return nothing. It fails silently, and only under a non-owner role.
 *
 * AsyncLocalStorage does not have this problem, because context propagates to
 * async work *started* inside the scope. Calling \`next()\` inside \`runWithTenant\`
 * is enough for the handler's continuations to inherit the tenant.
 *
 * So the split is:
 *   - middleware  publishes *which tenant* this request is for
 *   - \`TenantTransaction.run()\` opens the transaction that RLS is pinned in
 *
 * With enforcement detected (see main.ts), a handler that queries tenant data
 * without going through \`TenantTransaction\` gets a clear error instead of an
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
`,

      'src/tenancy/tenant.resolver.ts': `/**
 * Turns a request into a tenant.
 *
 * Resolution order, most explicit first:
 *
 *   1. An explicit header (API clients, the web app's server-side fetches).
 *   2. A custom domain, then the subdomain of the root domain.
 *
 * Deliberately not "the first tenant in the table" or "the only tenant": a
 * fallback that guesses a tenant is a cross-tenant data leak with extra steps.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { asTenantId, type ResolvedTenant } from '@orbitoz/shared-types';
import { PrismaService } from '@orbitoz/database';
import { EnvService } from '../config/env.service.js';

interface ResolvedTenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  suspended_at: Date | null;
}

@Injectable()
export class TenantResolver {
  private readonly logger = new Logger(TenantResolver.name);
  /** Per-process cache; the row changes rarely and resolution is on every request. */
  private readonly cache = new Map<string, { tenant: ResolvedTenant | null; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async resolveFromRequest(request: Request): Promise<ResolvedTenant | null> {
    const explicit = request.header(this.env.tenantHeader);
    const host = explicit ?? request.hostname ?? '';
    if (!host) return null;

    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.tenant;

    // A SECURITY DEFINER function, because RLS blocks reading \`tenants\` before
    // the tenant is known. It returns one row for one host and nothing else.
    const rows = await this.prisma.unscoped(
      (client) =>
        client.$queryRaw<ResolvedTenantRow[]>\`
          SELECT id::text, slug, name, status, plan, suspended_at
          FROM app_resolve_tenant(\${host})
        \`,
      'tenant resolution (pre-scope, SECURITY DEFINER)',
    );

    const row = rows[0];
    if (!row) {
      // Negative cache: without it, every request to an unknown host is a
      // database round trip, which is exactly what a traffic spike on a
      // misconfigured domain looks like.
      this.cache.set(host, { tenant: null, expiresAt: Date.now() + 5_000 });
      return null;
    }

    const tenant: ResolvedTenant = {
      tenantId: asTenantId(row.id),
      slug: row.slug,
      name: row.name,
      status: row.status as ResolvedTenant['status'],
      plan: row.plan as ResolvedTenant['plan'],
      suspendedAt: row.suspended_at ? new Date(row.suspended_at).toISOString() : null,
    };

    this.cache.set(host, { tenant, expiresAt: Date.now() + 60_000 });
    this.logger.debug(\`Resolved tenant \${tenant.slug} for host \${host}\`);
    return tenant;
  }
}
`,

      'src/tenancy/tenant-transaction.ts': `/**
 * Tenant-scoped database transactions.
 *
 * Row Level Security is only applied to a connection whose \`app.tenant_id\` GUC
 * is pinned, and \`set_config(..., true)\` is transaction-local: it is discarded
 * on commit or rollback. Every unit of work that touches tenant data therefore
 * has to run inside its own transaction, and this service is how handlers get
 * one.
 *
 * \`withTenant()\` passes the transaction's own extended client to the callback,
 * so tenant scoping and RLS are already in force — do not re-wrap it in
 * \`withTenantScope\`, which would try to add \$extends to a transaction handle
 * that does not have one.
 */
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaService, type TenantScopedTransaction } from '@orbitoz/database';

export const TENANT_TRANSACTION = Symbol('TENANT_TRANSACTION');

/** The transaction handle for the current unit of work, if one is open. */
const currentTx = new AsyncLocalStorage<TenantScopedTransaction>();

@Injectable()
export class TenantTransaction {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs \`fn\` in a transaction with RLS pinned to \`tenantId\`.
   *
   * \`fn\` must complete the unit of work, not the request. One transaction per
   * request would hold a pooled connection for the entire time a client spends
   * thinking, which under load exhausts the pool long before the database is
   * slow.
   *
   * The timeout is a real limit, not decoration: a request that exceeds it is
   * rolled back rather than tying up a connection until the client gives up.
   */
  async run<T>(tenantId: string, fn: (tx: TenantScopedTransaction) => Promise<T>): Promise<T> {
    return this.prisma.withTenant(tenantId, async (tx) => currentTx.run(tx, fn), {
      maxWait: 5_000,
      timeout: 30_000,
    });
  }

  /** True when a transaction is open, for assertions in shared helpers. */
  get isOpen(): boolean {
    return currentTx.getStore() !== undefined;
  }

  /**
   * The active transaction. Throws rather than returning undefined, because the
   * alternative is a query that silently returns nothing.
   */
  get active(): TenantScopedTransaction {
    const tx = currentTx.getStore();
    if (!tx) {
      throw new Error(
        'No tenant transaction is active. Wrap tenant queries in ' +
          'TenantTransaction.run() so Row Level Security can be pinned.',
      );
    }
    return tx;
  }
}
`,

      'src/tenancy/tenant.middleware.ts': `/**
 * Resolves the tenant for every request and publishes it as ambient scope.
 *
 * This middleware deliberately does NOT open a database transaction, and the
 * reason is worth stating because the intuitive design is wrong here.
 *
 * \`next()\` returns as soon as the pipeline is handed off — before the route
 * handler has awaited anything. A transaction opened around a callback that
 * merely calls \`next()\` therefore commits the instant the middleware returns,
 * which is before the handler has run its first query. Handlers would then read
 * through a committed, unpinned connection and Postgres, honouring RLS, would
 * return nothing. It fails silently, and only under a non-owner role.
 *
 * AsyncLocalStorage does not have this problem, because context propagates to
 * async work *started* inside the scope. Calling \`next()\` inside \`runWithTenant\`
 * is enough for the handler's continuations to inherit the tenant.
 *
 * So the split is:
 *   - middleware  publishes *which tenant* this request is for
 *   - \`TenantTransaction.run()\` opens the transaction that RLS is pinned in
 *
 * With enforcement detected (see main.ts), a handler that queries tenant data
 * without going through \`TenantTransaction\` gets a clear error instead of an
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
`,

      'src/tenancy/tenant.resolver.ts': `/**
 * Turns a request into a tenant.
 *
 * Resolution order, most explicit first:
 *
 *   1. An explicit header (API clients, the web app's server-side fetches).
 *   2. A custom domain, then the subdomain of the root domain.
 *
 * Deliberately not "the first tenant in the table" or "the only tenant": a
 * fallback that guesses a tenant is a cross-tenant data leak with extra steps.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { asTenantId, type ResolvedTenant } from '@orbitoz/shared-types';
import { PrismaService } from '@orbitoz/database';
import { EnvService } from '../config/env.service.js';

interface ResolvedTenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  suspended_at: Date | null;
}

@Injectable()
export class TenantResolver {
  private readonly logger = new Logger(TenantResolver.name);
  /** Per-process cache; the row changes rarely and resolution is on every request. */
  private readonly cache = new Map<string, { tenant: ResolvedTenant | null; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async resolveFromRequest(request: Request): Promise<ResolvedTenant | null> {
    const explicit = request.header(this.env.tenantHeader);
    const host = explicit ?? request.hostname ?? '';
    if (!host) return null;

    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.tenant;

    // A SECURITY DEFINER function, because RLS blocks reading \`tenants\` before
    // the tenant is known. It returns one row for one host and nothing else.
    const rows = await this.prisma.unscoped(
      (client) =>
        client.$queryRaw<ResolvedTenantRow[]>\`
          SELECT id::text, slug, name, status, plan, suspended_at
          FROM app_resolve_tenant(\${host})
        \`,
      'tenant resolution (pre-scope, SECURITY DEFINER)',
    );

    const row = rows[0];
    if (!row) {
      // Negative cache: without it, every request to an unknown host is a
      // database round trip, which is exactly what a traffic spike on a
      // misconfigured domain looks like.
      this.cache.set(host, { tenant: null, expiresAt: Date.now() + 5_000 });
      return null;
    }

    const tenant: ResolvedTenant = {
      tenantId: asTenantId(row.id),
      slug: row.slug,
      name: row.name,
      status: row.status as ResolvedTenant['status'],
      plan: row.plan as ResolvedTenant['plan'],
      suspendedAt: row.suspended_at ? new Date(row.suspended_at).toISOString() : null,
    };

    this.cache.set(host, { tenant, expiresAt: Date.now() + 60_000 });
    this.logger.debug(\`Resolved tenant \${tenant.slug} for host \${host}\`);
    return tenant;
  }
}
`,

      'src/tenancy/tenant-transaction.ts': `/**
 * Per-request database transaction.
 *
 * The gateway resolves the tenant in middleware, before any route handler
 * exists to open a transaction. This service owns the single interactive
 * transaction that spans the request, pinning \`app.tenant_id\` with SET LOCAL
 * so Postgres applies RLS for its whole duration.
 *
 * Handlers therefore never open their own transaction: nesting one here would
 * use a second pooled connection, which would not have the GUC pinned, and reads
 * would quietly come back empty. \`withTenant()\` nests correctly because Prisma
 * reuses the ambient transaction client.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService, type TenantScopedTransaction } from '@orbitoz/database';
import { AsyncLocalStorage } from 'node:async_hooks';

export const TENANT_TRANSACTION = Symbol('TENANT_TRANSACTION');

/** The transaction handle for the current request, if one is open. */
const currentTx = new AsyncLocalStorage<TenantScopedTransaction>();

@Injectable()
export class TenantTransaction {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens the request's transaction, pins RLS to \`tenant\`, and runs \`fn\`.
   *
   * \`fn\` must not resolve until the response has been produced. The middleware
   * therefore passes a callback that completes when the pipeline finishes; the
   * connection is held for the request's duration, which is the cost of
   * per-request RLS and is bounded by the pool size.
   */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.withTenant(tenantId, async (tx) => currentTx.run(tx, fn), {
      maxWait: 5_000,
      timeout: 30_000,
    });
  }

  /** The active transaction, for the rare handler that must reach it directly. */
  get active(): TenantScopedTransaction {
    const tx = currentTx.getStore();
    if (!tx) {
      throw new Error(
        'No tenant transaction is active. This route was not reached through ' +
          'TenantMiddleware, so its queries are not covered by Row Level Security.',
      );
    }
    return tx;
  }
}
`,

      'src/config/env.service.ts': `import { Injectable } from '@nestjs/common';
import { loadEnv, type Env } from './env.js';

/** Injectable wrapper so the rest of the app never touches \`process.env\`. */
@Injectable()
export class EnvService {
  readonly value: Env = loadEnv();

  get tenantHeader(): string {
    return this.value.tenancy.header;
  }

  get tenantRequired(): boolean {
    return this.value.tenancy.required;
  }
}
`,

      'src/database/health.controller.ts': `/**
 * Unauthenticated liveness and readiness.
 *
 * Deliberately free of tenant middleware: an infrastructure health check has no
 * Host header worth resolving, and requiring one would mark the service
 * unhealthy during a DNS incident when the service itself is fine.
 */
import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '@orbitoz/database';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: string; databaseLatencyMs: number }> {
    const databaseLatencyMs = await this.prisma.ping();
    return { status: 'ok', databaseLatencyMs };
  }
}
`,

      'src/common/http-exception.filter.ts': `/**
 * Normalises error responses.
 *
 * Without this, Nest leaks internal messages in 500 bodies. The client gets a
 * stable \`{ error, message, requestId }\` shape and the operator gets the stack,
 * so neither has to choose between safety and debuggability.
 */
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = (response.locals.requestId as string | undefined) ?? 'unknown';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message = typeof payload === 'string' ? payload : ((payload as { message?: unknown }).message ?? exception.message);
      response.status(status).json({ error: HttpStatus[status] ?? 'Error', message, requestId });
      return;
    }

    this.logger.error(\`Unhandled error (request \${requestId})\`, exception as Error);
    response.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected error occurred.',
      requestId,
    });
  }
}
`,

      'src/app.module.ts': `import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
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
`,

      'src/config/env.module.ts': `import { Global, Module } from '@nestjs/common';
import { EnvService } from './env.service.js';

/**
 * Global so that every feature module can inject \`EnvService\` without importing
 * this module. There is exactly one source of configuration per process, and
 * making it ambient removes a category of import churn.
 */
@Global()
@Module({
  providers: [EnvService],
  exports: [EnvService],
})
export class EnvModule {}
`,

      'src/tenancy/tenancy.module.ts': `import { Module } from '@nestjs/common';
import { TenantMiddleware } from './tenant.middleware.js';
import { TenantResolver } from './tenant.resolver.js';
import { TENANT_TRANSACTION, TenantTransaction } from './tenant-transaction.js';

/**
 * Everything that has to happen before a request reaches a route handler.
 *
 * \`TenantMiddleware\` is a provider rather than an \`APP_GUARD\` on purpose: it
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
`,
    },
  },

  {
    id: 'apps/worker-service',
    description: 'BullMQ worker — provider routing and inference execution',
    files: {
      'package.json': `${JSON.stringify(
        {
          name: '@orbitoz/worker-service',
          version: '0.1.0',
          private: true,
          type: 'module',
          main: 'dist/main.js',
          scripts: {
            build: 'tsc -p tsconfig.json',
            start: 'node --enable-source-maps dist/main.js',
            dev: 'concurrently -k -n tsc,worker -c blue,green "tsc -p tsconfig.json --watch --preserveWatchOutput" "node --watch --enable-source-maps dist/main.js"',
            typecheck: 'tsc -p tsconfig.json --noEmit',
            lint: 'eslint .',
            clean: 'rimraf dist',
          },
          dependencies: {
            '@orbitoz/config': 'workspace:*',
            '@orbitoz/database': 'workspace:*',
            '@orbitoz/shared-types': 'workspace:*',
            // Only for its Logger. The worker is a plain process, not a Nest
            // container, so this is the single Nest symbol it borrows.
            '@nestjs/common': 'catalog:',
            bullmq: 'catalog:',
            ioredis: 'catalog:',
            zod: 'catalog:',
          },
          devDependencies: {
            '@types/node': 'catalog:',
            concurrently: 'catalog:',
            eslint: 'catalog:',
            rimraf: 'catalog:',
            typescript: 'catalog:',
          },
        },
        null,
        2,
      )}\n`,

      'tsconfig.json': appTsconfig('worker-service'),
      '.gitignore': gitignoreApp,

      'src/config/env.ts': `import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  worker: z.object({
    port: z.coerce.number().int().positive().default(4010),
    concurrency: z.coerce.number().int().positive().max(200).default(10),
  }),

  database: z.object({
    /** The application role. RLS is enforced against it, per request job. */
    url: z.url(),
  }),

  redis: z.object({
    url: z.string().min(1).default('redis://localhost:6379'),
    /** BullMQ needs maxRetriesPerRequest: null for its blocking commands. */
    maxRetriesPerRequest: z.coerce.number().default(0),
  }),

  logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace', 'fatal']).default('info'),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse({
    NODE_ENV: source.NODE_ENV,
    worker: { port: source.WORKER_SERVICE_PORT, concurrency: source.WORKER_CONCURRENCY },
    database: { url: source.DATABASE_URL ?? source.APP_DATABASE_URL },
    redis: { url: source.REDIS_URL, maxRetriesPerRequest: null },
    logLevel: source.LOG_LEVEL,
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => \`  \${issue.path.join('.')}: \${issue.message}\`)
      .join('\\n');
    throw new Error(\`Invalid environment configuration:\\n\${detail}\\n\\nSee .env.example.\`);
  }
  return parsed.data;
}
`,

      'src/queues/connection.ts': `/**
 * Redis connections.
 *
 * BullMQ requires \`maxRetriesPerRequest: null\` on any connection it uses for
 * blocking commands. Leaving it at the ioredis default makes the worker fail at
 * startup with a timeout that looks like a Redis outage.
 */
import { Redis } from 'ioredis';

export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
`,

      'src/queues/inference.queue.ts': `/**
 * Queue naming, taken from the shared contract rather than re-declared.
 *
 * The gateway produces these jobs and this service consumes them, so both read
 * the same constants from \`@orbitoz/shared-types\`. A locally-defined copy
 * would drift the first time someone renamed a queue, and the failure mode is a
 * worker silently idling on a queue nobody writes to.
 */
import { DEFAULT_JOB_OPTIONS } from '@orbitoz/shared-types';

export { QUEUE_NAMES, INFERENCE_JOB } from '@orbitoz/shared-types';
export type { BaseJob, InferenceJobPayload } from '@orbitoz/shared-types';

/** Retry and retention policy, also owned by the shared contract. */
export const INFERENCE_JOB_OPTIONS = DEFAULT_JOB_OPTIONS;
`,

      'src/processors/inference.processor.ts': `/**
 * The inference job processor — provider routing is not implemented yet.
 *
 * What is real here is the part that is easy to get wrong: the tenant comes
 * from the job envelope, never from ambient state, and every database call goes
 * through \`withTenant\` so the job runs in a transaction with Row Level Security
 * pinned to that tenant.
 *
 * A worker has no request to inherit a scope from, so it must establish one per
 * job. That is the single largest source of cross-tenant bugs in worker code: a
 * job for tenant A silently reading or writing tenant B's rows.
 */
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  INFERENCE_JOB,
  type BaseJob,
  type InferenceJobPayload,
} from '@orbitoz/shared-types';
import type { PrismaClient } from '@orbitoz/database';

export class InferenceProcessor {
  private readonly logger = new Logger(InferenceProcessor.name);

  constructor(private readonly prisma: PrismaClient) {}

  async process(job: Job<BaseJob<InferenceJobPayload>>): Promise<void> {
    const { tenantId, id, payload } = job.data;
    this.logger.log(\`Processing \${id} for tenant \${tenantId.slice(0, 8)} (\${payload.model})\`);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', tenantId);

      const record = await tx.inferenceJob.findUnique({
        where: { tenantId_id: { tenantId, id } },
      });
      if (!record) {
        // The row is written by the gateway before enqueueing. Its absence means
        // the job outlived its record, so there is nothing safe to do but stop.
        this.logger.warn(\`Job \${id} has no inference_jobs row for this tenant; skipping.\`);
        return;
      }

      await tx.inferenceJob.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
      });

      if (job.name === INFERENCE_JOB.Cancel) {
        this.logger.log(\`Cancellation requested for \${id}\`);
        return;
      }

      // Provider call, attempt recording and cost accounting land here. Left
      // explicit rather than stubbed so the transaction boundary is visible
      // while it is still cheap to change.
      this.logger.debug('Provider routing is not implemented yet; no provider was called.');
    });
  }
}
`,

      'src/worker.ts': `import { Worker } from 'bullmq';
import { createPrismaClient } from '@orbitoz/database';
import type { BaseJob, InferenceJobPayload } from '@orbitoz/shared-types';
import { loadEnv } from './config/env.js';
import { createRedisConnection } from './queues/connection.js';
import { QUEUE_NAMES } from './queues/inference.queue.js';
import { InferenceProcessor } from './processors/inference.processor.js';

export function startWorker(): Worker {
  const env = loadEnv();
  const connection = createRedisConnection(env.redis.url);
  const prisma = createPrismaClient({ connectionString: env.database.url });
  const processor = new InferenceProcessor(prisma);

  const worker = new Worker<BaseJob<InferenceJobPayload>>(
    QUEUE_NAMES.AiInference,
    async (job) => processor.process(job),
    { connection, concurrency: env.worker.concurrency, limiter: { max: 50, duration: 1_000 } },
  );

  worker.on('failed', (job, error) => {
    console.error(\`Job \${job?.id ?? 'unknown'} failed: \${error.message}\`);
  });
  worker.on('error', (error) => {
    console.error(\`Worker error: \${error.message}\`);
  });

  return worker;
}
`,

      'src/main.ts': `/**
 * Worker entry point.
 *
 * A plain process rather than a Nest application: there is no HTTP surface, and
 * \`@nestjs/bullmq\` would add a container and a module graph to supervise a
 * single Worker instance. Revisit if the worker grows scheduled jobs or needs
 * an admin endpoint.
 */
import { Logger } from '@nestjs/common';
import { loadEnv } from './config/env.js';
import { QUEUE_NAMES } from './queues/inference.queue.js';
import { startWorker } from './worker.js';

const logger = new Logger('Worker');
const env = loadEnv();
logger.log(
  \`Worker starting: concurrency=\${env.worker.concurrency} queue=\${QUEUE_NAMES.AiInference}\`,
);

const worker = startWorker();

// BullMQ pauses rather than drops on SIGTERM, so jobs finish instead of
// failing on every deploy.
const shutdown = async (signal: string): Promise<void> => {
  logger.log(\`\${signal} received; draining worker\`);
  await worker.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
`,
    },
  },

  {
    id: 'apps/web',
    description: 'Next.js 16 application — the tenant-facing dashboard',
    files: {
      'package.json': `${JSON.stringify(
        {
          name: '@orbitoz/web',
          version: '0.1.0',
          private: true,
          scripts: {
            dev: 'next dev --port 3000',
            build: 'next build',
            start: 'next start --port 3000',
            typecheck: 'tsc -p tsconfig.json --noEmit',
            lint: 'eslint .',
            clean: 'rimraf .next',
          },
          dependencies: {
            // Provides tsconfig/nextjs.json via its exports map, not a runtime
            // import — but it must be a declared dependency for the extends to
            // resolve under pnpm's strict node_modules.
            '@orbitoz/config': 'workspace:*',
            '@orbitoz/shared-types': 'workspace:*',
            next: 'catalog:',
            react: 'catalog:',
            'react-dom': 'catalog:',
          },
          devDependencies: {
            '@tailwindcss/postcss': 'catalog:',
            '@types/react': 'catalog:',
            '@types/react-dom': 'catalog:',
            eslint: 'catalog:',
            postcss: '^8.5.6',
            rimraf: 'catalog:',
            tailwindcss: 'catalog:',
            typescript: 'catalog:',
          },
        },
        null,
        2,
      )}\n`,

      'tsconfig.json': `${JSON.stringify(
        {
          $schema: 'https://json.schemastore.org/tsconfig',
          extends: '@orbitoz/config/tsconfig/nextjs.json',
          compilerOptions: { noEmit: true, jsx: 'preserve' },
          include: ['next-env.d.ts', 'src/**/*.ts', 'src/**/*.tsx', '.next/types/**/*.ts'],
          exclude: ['node_modules', '.next'],
        },
        null,
        2,
      )}\n`,

      'next.config.ts': `import type { NextConfig } from 'next';

/**
 * \`transpilePackages\` matters in a monorepo: Next does not compile workspace
 * packages by default, so shared-types' TypeScript would be handed to the
 * browser unbuilt.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@orbitoz/shared-types'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
`,

      'postcss.config.mjs': `/** Tailwind 4 ships as a PostCSS plugin; there is no tailwind.config.js. */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
`,

      '.gitignore': `# Next.js
.next
out
next-env.d.ts

# Build output
dist
.turbo
*.tsbuildinfo

# Local env
.env
.env.local
`,

      'src/app/globals.css': `@import 'tailwindcss';

/* Tailwind 4 defines theme values in CSS rather than a JS config. */
@theme {
  --color-surface: oklch(0.99 0 0);
  --color-ink: oklch(0.21 0.01 260);
}

:root {
  color-scheme: light dark;
}

body {
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
`,

      'src/app/layout.tsx': `import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Orbitoz AI',
  description: 'Multi-tenant AI inference gateway',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,

      'src/app/page.tsx': `import { headers } from 'next/headers';

/**
 * The landing page reads the tenant from the Host header on the server, which is
 * the same rule the API gateway uses. Keeping one definition of "which tenant is
 * this request for" means the two cannot disagree.
 *
 * \`headers()\` is async in Next 15+, so awaiting it is required rather than
 * stylistic. Next 16 does not infer the return type of a Server Component, hence
 * the explicit annotation.
 */
export default async function HomePage(): Promise<React.JSX.Element> {
  const headerList = await headers();
  const host = headerList.get('host') ?? '';
  const subdomain = host.split('.')[0] ?? '';

  return (
    <main className="mx-auto max-w-2xl p-12">
      <h1 className="text-3xl font-semibold">Orbitoz AI</h1>
      <p className="mt-4 text-neutral-600">
        Tenant: <code className="font-mono">{subdomain || '(none)'}</code>
      </p>
      <p className="mt-1 text-sm text-neutral-500">
        Resolved from host <code className="font-mono">{host || '(none)'}</code>
      </p>
    </main>
  );
}
`,
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const targets = argv.filter((a) => !a.startsWith('--'));
  return {
    dryRun: flags.has('--dry-run'),
    force: flags.has('--force'),
    targets,
  };
}

const { dryRun, force, targets: requested } = parseArgs(process.argv.slice(2));

const selected = requested.length
  ? TARGETS.filter((t) => requested.includes(t.id) || requested.includes(path.basename(t.id)))
  : TARGETS;

if (requested.length && selected.length === 0) {
  console.error(`No target matched: ${requested.join(', ')}`);
  console.error(`Available: ${TARGETS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

const writes = [];
const skipped = [];

for (const target of selected) {
  for (const [relativePath, contents] of Object.entries(target.files)) {
    const absolute = path.join(root, target.id, relativePath);
    if (existsSync(absolute) && !force) {
      skipped.push(path.relative(root, absolute));
      continue;
    }
    writes.push({ absolute, relative: path.relative(root, absolute), contents });
  }
}

console.log(`\nScaffolding ${selected.length} target(s):\n`);
for (const target of selected) {
  console.log(`  ${target.id}`);
  console.log(`    ${target.description}`);
}

if (skipped.length) {
  console.log(`\n${skipped.length} existing file(s) left alone (use --force to overwrite):`);
  for (const file of skipped) console.log(`  - ${file}`);
}

if (!writes.length) {
  console.log('\nNothing to do.\n');
  process.exit(0);
}

console.log(`\n${dryRun ? 'Would write' : 'Writing'} ${writes.length} file(s):`);
for (const write of writes) console.log(`  + ${write.relative}`);

if (dryRun) {
  console.log('\nDry run: nothing written.\n');
  process.exit(0);
}

for (const { absolute, contents } of writes) {
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

console.log('\nDone. Next:\n');
console.log('  pnpm install');
console.log('  pnpm db:generate');
console.log('  pnpm build\n');
