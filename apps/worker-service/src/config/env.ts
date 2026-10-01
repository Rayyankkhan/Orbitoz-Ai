import { z } from 'zod';

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
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}\n\nSee .env.example.`);
  }
  return parsed.data;
}
