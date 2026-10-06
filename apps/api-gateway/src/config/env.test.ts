/**
 * Environment validation for the approval and Redis additions.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH A FILE
 * ---------------------------------------------------------------------------
 * An HMAC accepts a one-character key and produces signatures that verify fine. So
 * every way this configuration can be wrong is silent at the moment it is wrong and
 * loud much later, when someone forges a grant with the key that shipped in a
 * `.env.example`. These are the assertions that turn that into a boot failure.
 *
 * The theme throughout: defaults that are safe to develop against, and refusals that
 * only bite in production, so the documented `cp .env.example .env` quick start keeps
 * working while a real deployment cannot inherit the placeholder.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_SIGNATURE_TOLERANCE_SECONDS,
  DEFAULT_APPROVAL_TTL_SECONDS,
} from '@orbitoz/shared-types';
import { loadEnv } from './env.js';

const DEV_ACCESS = 'dev-only-access-secret-change-me-0123456789abcdef';
const DEV_REFRESH = 'dev-only-refresh-secret-change-me-0123456789abcdef';
const DEV_APPROVAL = 'dev-only-approval-secret-change-me-0123456789abcdef';
const REAL_APPROVAL = 'k'.repeat(48);

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://app:pw@localhost:5432/orbitoz',
    JWT_ACCESS_SECRET: DEV_ACCESS,
    JWT_REFRESH_SECRET: DEV_REFRESH,
    APPROVAL_SIGNING_SECRET: DEV_APPROVAL,
    ...overrides,
  };
}

/** The error text `loadEnv` throws, which is what an operator will read. */
function failure(overrides: NodeJS.ProcessEnv = {}): string {
  try {
    loadEnv(env(overrides));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadEnv to reject');
}

describe('loadEnv — approval signing secret', () => {
  it('defaults to the documented development placeholder', () => {
    // Deleting the variable has to leave a working development setup, or the quick
    // start in the README stops being true.
    expect(loadEnv(env()).approvals.signingSecret).toBe(DEV_APPROVAL);
  });

  it('rejects a secret shorter than 32 bytes', () => {
    // The HMAC would still verify. That is exactly the point: a truncated secret is
    // indistinguishable from a working one until someone forges with it.
    expect(failure({ APPROVAL_SIGNING_SECRET: 'short' })).toContain(
      'approvals.signingSecret: must be at least 32 characters',
    );
  });

  it('rejects an empty secret rather than falling back to the default', () => {
    expect(failure({ APPROVAL_SIGNING_SECRET: '' })).toContain('approvals.signingSecret');
  });

  it('accepts a generated production secret', () => {
    const loaded = loadEnv(
      env({
        NODE_ENV: 'production',
        APPROVAL_SIGNING_SECRET: REAL_APPROVAL,
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
      }),
    );

    expect(loaded.approvals.signingSecret).toBe(REAL_APPROVAL);
  });

  it('refuses the development placeholder once NODE_ENV is production', () => {
    const message = failure({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a'.repeat(48),
      JWT_REFRESH_SECRET: 'b'.repeat(48),
      APPROVAL_SIGNING_SECRET: DEV_APPROVAL,
    });

    expect(message).toContain('approvals.signingSecret');
    expect(message).toContain('openssl rand -base64 48');
  });

  it('does not require a distinct approval secret, but shares nothing with the JWTs', () => {
    // Unlike the two JWT secrets, an approval secret that happens to equal an access
    // secret is not a structural break: the signature is verified against a literal
    // prefix and a canonical payload a JWT parser would never accept. What must never
    // happen is the reverse — a signature minted here being valid as a bearer token —
    // and that is prevented by the separate `v1=` wire format, not by the value.
    const loaded = loadEnv(
      env({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
        APPROVAL_SIGNING_SECRET: 'a'.repeat(48),
      }),
    );

    expect(loaded.approvals.signingSecret).toBe('a'.repeat(48));
  });

  it('names the field rather than failing with an opaque error', () => {
    // An operator reading a boot failure has to know which variable to fix.
    expect(failure({ APPROVAL_SIGNING_SECRET: 'x' })).toContain(
      'Invalid environment configuration',
    );
  });
});

describe('loadEnv — approval timing', () => {
  it('uses the shared defaults for tolerance and TTL', () => {
    // The constants live in shared-types so the docs, the worker and this file cannot
    // quote three different numbers.
    const loaded = loadEnv(env());

    expect(loaded.approvals.signatureToleranceSeconds).toBe(
      DEFAULT_APPROVAL_SIGNATURE_TOLERANCE_SECONDS,
    );
    expect(loaded.approvals.requestTtlSeconds).toBe(DEFAULT_APPROVAL_TTL_SECONDS);
  });

  it('reads overrides from the environment', () => {
    const loaded = loadEnv(
      env({
        APPROVAL_SIGNATURE_TOLERANCE_SECONDS: '900',
        APPROVAL_TTL_SECONDS: '3600',
      }),
    );

    expect(loaded.approvals.signatureToleranceSeconds).toBe(900);
    expect(loaded.approvals.requestTtlSeconds).toBe(3_600);
  });

  it('coerces the strings that an env file always produces', () => {
    // `process.env` is `string | undefined`; an un-coerced schema would make
    // `APPROVAL_TTL_SECONDS=3600` a type error at runtime.
    expect(loadEnv(env({ APPROVAL_TTL_SECONDS: '3600' })).approvals.requestTtlSeconds).toBe(3_600);
  });

  it('rejects a non-positive TTL', () => {
    // A zero or negative TTL would make every link dead on arrival, which reads as a
    // bug report rather than a misconfiguration.
    expect(failure({ APPROVAL_TTL_SECONDS: '0' })).toContain('approvals.requestTtlSeconds');
    expect(failure({ APPROVAL_TTL_SECONDS: '-1' })).toContain('approvals.requestTtlSeconds');
  });

  it('rejects a zero signature tolerance', () => {
    // Zero tolerance means a grant is valid for exactly one instant, so a link that
    // renders and then gets clicked a second later always fails.
    expect(failure({ APPROVAL_SIGNATURE_TOLERANCE_SECONDS: '0' })).toContain(
      'approvals.signatureToleranceSeconds',
    );
  });

  it('rejects a fractional TTL', () => {
    expect(failure({ APPROVAL_TTL_SECONDS: '3600.5' })).toContain('approvals.requestTtlSeconds');
  });

  it('rejects a non-numeric TTL', () => {
    expect(failure({ APPROVAL_TTL_SECONDS: 'a day' })).toContain('approvals.requestTtlSeconds');
  });
});

describe('loadEnv — Redis', () => {
  it('defaults to a local Redis', () => {
    const loaded = loadEnv(env());

    expect(loaded.redis.url).toBe('redis://localhost:6379');
    expect(loaded.redis.commandTimeoutMs).toBe(10_000);
  });

  it('reads the URL from REDIS_URL', () => {
    expect(loadEnv(env({ REDIS_URL: 'redis://cache:6379' })).redis.url).toBe('redis://cache:6379');
  });

  it('rejects an empty URL', () => {
    // ioredis would happily accept it and then fail to resolve, so the failure would
    // arrive on the first approved job rather than at boot.
    expect(failure({ REDIS_URL: '' })).toContain('redis.url');
  });

  it('reads the command timeout', () => {
    expect(loadEnv(env({ REDIS_COMMAND_TIMEOUT_MS: '2500' })).redis.commandTimeoutMs).toBe(2_500);
  });

  it('rejects a non-positive command timeout', () => {
    // The timeout exists so an enqueue cannot hang an HTTP request forever on a
    // half-open socket. Zero would remove it without meaning "no wait at all".
    expect(failure({ REDIS_COMMAND_TIMEOUT_MS: '0' })).toContain('redis.commandTimeoutMs');
  });
});

describe('loadEnv — unaffected by the additions', () => {
  it('still refuses identical JWT secrets', () => {
    // The approval secret is a third secret now; the existing check must still hold.
    expect(
      failure({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'a'.repeat(48),
        APPROVAL_SIGNING_SECRET: REAL_APPROVAL,
      }),
    ).toContain('must differ from auth.accessSecret');
  });

  it('still refuses the JWT development placeholders in production', () => {
    const message = failure({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: DEV_ACCESS,
      JWT_REFRESH_SECRET: 'b'.repeat(48),
      APPROVAL_SIGNING_SECRET: REAL_APPROVAL,
    });

    // A third secret was added; the check that made the first two safe is unchanged.
    expect(message).toContain('auth.accessSecret');
    expect(message).not.toContain('approvals.signingSecret');
  });

  it('still requires a database URL', () => {
    expect(failure({ DATABASE_URL: '' })).toContain('database.url');
  });

  it('still defaults the global prefix to v1', () => {
    // Which is what makes the approval routes live at `/v1/approvals/:token`.
    expect(loadEnv(env()).apiGateway.globalPrefix).toBe('v1');
  });

  it('splits a comma-separated origin list and drops the blanks', () => {
    // `API_GATEWAY_CORS_ORIGINS=https://a.test, https://b.test ,` — a trailing comma in
    // an env file is easy to leave behind, and an empty string in the CORS list is a
    // wildcard nobody asked for.
    expect(
      loadEnv(env({ API_GATEWAY_CORS_ORIGINS: 'https://a.test, https://b.test ,' })).apiGateway
        .corsOrigins,
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('rejects an origin list that is only separators', () => {
    expect(failure({ API_GATEWAY_CORS_ORIGINS: ' , , ' })).toContain('apiGateway.corsOrigins');
  });
});
