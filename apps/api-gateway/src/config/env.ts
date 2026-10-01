/**
 * Environment loading and validation.
 *
 * Parsed once at import time with Zod rather than read ad hoc throughout the
 * codebase. A typo in a variable name then fails at boot with a message naming
 * the variable, instead of surfacing as `undefined` in a request handler at
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
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}\n\nSee .env.example.`);
  }
  return parsed.data;
}
