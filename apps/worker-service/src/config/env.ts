import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  worker: z.object({
    port: z.coerce.number().int().positive().default(4010),
    concurrency: z.coerce.number().int().positive().max(200).default(10),
    /**
     * Tenants one worker process subscribes to, per queue-type.
     *
     * Each tenant costs two blocking connections (one blocking, one for
     * commands), so this is really a connection budget: 4 queue-types × 50
     * tenants × 2 = 400 connections. Redis's default `maxclients` is 10_000,
     * which several worker replicas exhaust quickly. Past this cap the worker
     * refuses new tenants rather than opening connections until Redis refuses
     * them — scale out horizontally instead.
     */
    maxTenants: z.coerce.number().int().positive().default(50),
    /** Aggregate job rate across all of this worker's tenants. */
    rateLimitMax: z.coerce.number().int().positive().default(50),
    rateLimitDurationMs: z.coerce.number().int().positive().default(1_000),
    /**
     * How often to re-read the tenant list.
     *
     * A poll rather than a pub/sub because the source of truth is the
     * `tenants` table, and a worker that starts after a tenant was created has
     * no notification to receive. The cost is one indexed `SELECT id` per
     * interval, which is negligible; the cost of getting it wrong is a tenant's
     * jobs sitting unconsumed until the next deploy.
     */
    tenantRefreshIntervalMs: z.coerce.number().int().positive().default(30_000),
  }),

  database: z.object({
    /** The application role. RLS is enforced against it, per request job. */
    url: z.url(),
  }),

  redis: z.object({
    url: z.string().min(1).default('redis://localhost:6379'),
    /**
     * Command timeout for producer-side connections, in milliseconds.
     *
     * There is deliberately no `maxConnections` setting. ioredis 6 removed the
     * per-client connection pool, so such a knob would be accepted and ignored;
     * connection count is bounded by `worker.maxTenants` instead, since BullMQ
     * opens two sockets per subscribed tenant.
     */
    commandTimeoutMs: z.coerce.number().int().positive().default(10_000),
  }),

  /**
   * Dead Letter Queue behaviour.
   *
   * Read only for observability and by the replay tooling — the routing itself is
   * decided in code by `decideDeadLetter`, not by configuration, so a config change
   * cannot silently stop dead-lettering.
   */
  dlq: z.object({
    /** How long a dead-lettered job is retained before an operator must act. */
    retentionDays: z.coerce.number().int().positive().default(30),
  }),

  logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace', 'fatal']).default('info'),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse({
    NODE_ENV: source.NODE_ENV,
    worker: {
      port: source.WORKER_SERVICE_PORT,
      concurrency: source.WORKER_CONCURRENCY,
      maxTenants: source.WORKER_MAX_TENANTS,
      rateLimitMax: source.WORKER_RATE_LIMIT_MAX,
      rateLimitDurationMs: source.WORKER_RATE_LIMIT_DURATION_MS,
      tenantRefreshIntervalMs: source.WORKER_TENANT_REFRESH_INTERVAL_MS,
    },
    database: { url: source.DATABASE_URL ?? source.APP_DATABASE_URL },
    redis: {
      url: source.REDIS_URL,
      commandTimeoutMs: source.WORKER_REDIS_COMMAND_TIMEOUT_MS,
    },
    dlq: { retentionDays: source.DLQ_RETENTION_DAYS },
    logLevel: source.LOG_LEVEL,
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}\n\nSee .env.example.`);
  }
  return parsed.data;
}
