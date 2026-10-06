/**
 * Environment loading and validation.
 *
 * Parsed once at import time with Zod rather than read ad hoc throughout the
 * codebase. A typo in a variable name then fails at boot with a message naming
 * the variable, instead of surfacing as `undefined` in a request handler at
 * 3am.
 */
import { z } from 'zod';
import {
  DEFAULT_APPROVAL_SIGNATURE_TOLERANCE_SECONDS,
  DEFAULT_APPROVAL_TTL_SECONDS,
  TOKEN_TTL,
} from '@orbitoz/shared-types';

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

/**
 * A signing secret.
 *
 * Length is validated because the failure mode is invisible: an HMAC accepts a
 * one-character key and produces signatures that verify fine, so a truncated or
 * placeholder secret in production looks exactly like a working one until
 * someone forges a token with it. Minimum 32 bytes, and the documented
 * development placeholders are rejected outright once `NODE_ENV=production`.
 */
const MIN_SECRET_BYTES = 32;

const DEVELOPMENT_SECRETS = new Set([
  'dev-only-access-secret-change-me-0123456789abcdef',
  'dev-only-refresh-secret-change-me-0123456789abcdef',
  'dev-only-approval-secret-change-me-0123456789abcdef',
]);

const secret = z.string().min(MIN_SECRET_BYTES, `must be at least ${MIN_SECRET_BYTES} characters`);

const schema = z
  .object({
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

    auth: z.object({
      accessSecret: secret,
      refreshSecret: secret,
      /**
       * Access tokens are deliberately short-lived. Every protected route
       * re-reads the principal's role from `memberships` rather than trusting the
       * token, so a stale role in a live access token cannot grant access for
       * longer than this window.
       */
      accessTtlSeconds: z.coerce.number().int().positive().default(TOKEN_TTL.Access),
      refreshTtlSeconds: z.coerce.number().int().positive().default(TOKEN_TTL.Refresh),
      issuer: z.string().min(1).default('orbitoz.ai'),
      audience: z.string().min(1).default('orbitoz.ai:api'),
      /**
       * Accepted clock skew when validating `exp`/`nbf`, in seconds. A little
       * tolerance prevents tokens minted by a node a few hundred milliseconds
       * ahead from being rejected as expired.
       */
      clockToleranceSeconds: z.coerce.number().int().min(0).default(5),
      /**
       * scrypt cost for newly created password hashes. Defaults match the format
       * `packages/database/prisma/seed.ts` writes, so seeded credentials verify.
       */
      scryptCost: z.object({
        N: z.coerce
          .number()
          .int()
          .min(2)
          .max(1 << 20)
          .default(16384),
        r: z.coerce.number().int().min(1).max(32).default(8),
        p: z.coerce.number().int().min(1).max(16).default(1),
      }),
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

    redis: z.object({
      /** Producer connection. The gateway enqueues approved jobs; it consumes none. */
      url: z.string().min(1).default('redis://localhost:6379'),
      /**
       * Upper bound on a single Redis command.
       *
       * Present because the gateway holds this connection *inside* an HTTP
       * request. An enqueue that hangs forever holds the request, its transaction
       * and a pooled Postgres connection open for as long as the socket stays
       * half-open; an error lets the handler answer, and the decision stays
       * durable for a retry.
       */
      commandTimeoutMs: z.coerce.number().int().positive().default(10_000),
    }),

    approvals: z.object({
      /**
       * HMAC key for approval decision grants.
       *
       * Separate from both JWT secrets. A signature minted for an approval link
       * must not be presentable anywhere a JWT is accepted, and a shared key
       * would make that structural impossibility into a coincidence.
       */
      signingSecret: secret,
      /**
       * Accepted clock difference on a decision grant, in seconds.
       *
       * Generous enough to click a link on a phone, short enough that a
       * signature sitting in a browser history is dead by the next day.
       */
      signatureToleranceSeconds: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_APPROVAL_SIGNATURE_TOLERANCE_SECONDS),
      /**
       * How long an approval link stays decidable, in seconds.
       *
       * A day is long enough for a person to notice the request and act on it,
       * and short enough that an approval queue does not accumulate month-old
       * "run this now" jobs nobody meant to authorise.
       */
      requestTtlSeconds: z.coerce.number().int().positive().default(DEFAULT_APPROVAL_TTL_SECONDS),
    }),

    logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace', 'fatal']).default('info'),
  })
  .superRefine((value, ctx) => {
    // Only enforced in production. Refusing to boot in development would make the
    // documented `cp .env.example .env` quick start impossible, and the risk the
    // check addresses — a committed placeholder reaching a real deployment — does
    // not exist locally.
    if (value.NODE_ENV !== 'production') return;

    for (const key of ['accessSecret', 'refreshSecret'] as const) {
      if (DEVELOPMENT_SECRETS.has(value.auth[key])) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', key],
          message:
            'is the documented development placeholder. Generate one per environment, ' +
            'e.g. `openssl rand -base64 48`.',
        });
      }
    }

    if (DEVELOPMENT_SECRETS.has(value.approvals.signingSecret)) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvals', 'signingSecret'],
        message:
          'is the documented development placeholder. Generate one per environment, ' +
          'e.g. `openssl rand -base64 48`.',
      });
    }

    if (value.auth.accessSecret === value.auth.refreshSecret) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'refreshSecret'],
        message:
          'must differ from auth.accessSecret. Sharing a key lets a refresh token be ' +
          'presented as an access token.',
      });
    }
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
    auth: {
      accessSecret: source.JWT_ACCESS_SECRET,
      refreshSecret: source.JWT_REFRESH_SECRET,
      accessTtlSeconds: source.JWT_ACCESS_TTL,
      refreshTtlSeconds: source.JWT_REFRESH_TTL,
      issuer: source.JWT_ISSUER,
      audience: source.JWT_AUDIENCE,
      clockToleranceSeconds: source.JWT_CLOCK_TOLERANCE,
      scryptCost: {
        N: source.AUTH_SCRYPT_N,
        r: source.AUTH_SCRYPT_R,
        p: source.AUTH_SCRYPT_P,
      },
    },
    tenancy: {
      rootDomain: source.TENANT_ROOT_DOMAIN,
      header: source.TENANT_HEADER,
      required: source.TENANT_REQUIRED,
    },
    redis: {
      url: source.REDIS_URL,
      commandTimeoutMs: source.REDIS_COMMAND_TIMEOUT_MS,
    },
    approvals: {
      signingSecret: source.APPROVAL_SIGNING_SECRET,
      signatureToleranceSeconds: source.APPROVAL_SIGNATURE_TOLERANCE_SECONDS,
      requestTtlSeconds: source.APPROVAL_TTL_SECONDS,
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
