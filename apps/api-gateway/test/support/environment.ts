/**
 * Loads the repository's `.env` into `process.env` for integration tests.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A VITEST OPTION
 * ---------------------------------------------------------------------------
 * Vite's `envDir` populates `import.meta.env`, not `process.env`, and only for
 * `VITE_`-prefixed keys. `EnvService` reads `process.env` and nothing else — by
 * design, so application code never touches the import-meta object. There is
 * therefore no Vitest setting that makes the real config loader work, and no
 * reason for the tests to bypass it: constructing a real `EnvService` against a
 * real `.env` is one more thing this suite proves.
 *
 * The parsing below is deliberately minimal and deliberately the *last* writer:
 * an already-set variable wins, so `TEST_REDIS_URL=... pnpm test:integration`
 * overrides the file, which is the whole point of having a separate variable for
 * it. Values are not interpolated and are not unquoted beyond stripping one layer
 * of surrounding quotes, matching what `node --env-file` (used by `db:verify`)
 * does closely enough that the two entry points cannot disagree about, say,
 * whether a secret has surrounding whitespace.
 *
 * `loadEnv()` validates the whole environment and throws listing every missing
 * key at once, so a missing `.env` produces one comprehensible error rather than
 * a `undefined` surfacing as a confusing Postgres error thirty seconds later.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/.env`: up from `apps/api-gateway/test/support`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Values a test may override that are not in `.env` on a fresh checkout. */
const TEST_DEFAULTS: Readonly<Record<string, string>> = {
  // Separate from REDIS_URL on purpose, and defaulted to the same local instance
  // the worker's integration harness uses, because both suites create and then
  // delete keys and neither should need a second Redis to be useful.
  TEST_REDIS_URL: 'redis://localhost:6379',
  // `.env.example` documents this but a checkout that predates Module 05 will not
  // have it, and `EnvService` requires at least 32 bytes. A fixed value rather
  // than a random one so a failed integration run can be reproduced exactly.
  APPROVAL_SIGNING_SECRET: 'integration-test-signing-secret-not-a-real-secret-000000',
};

/**
 * Populates `process.env` from the repo `.env`, without overriding anything
 * already set. Idempotent, so calling it from several support modules is safe.
 */
export function loadRootEnv(): void {
  const path = resolve(REPO_ROOT, '.env');
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No .env at ${path}. These tests run against real infrastructure; run \`pnpm db:setup\` ` +
        'and copy .env.example to .env first.',
    );
  }

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    // Comments and blanks carry no value; a bare `export` prefix is accepted so a
    // .env copied from a shell snippet still works.
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (key === '' || key in process.env) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }

  for (const [key, value] of Object.entries(TEST_DEFAULTS)) {
    process.env[key] ??= value;
  }
}

/**
 * The Redis these tests are allowed to write to and delete from.
 *
 * The gateway's `QueueProducer` has no notion of a test Redis — it reads
 * `env.value.redis.url` like any other value — so the test points `REDIS_URL` at
 * the disposable instance before any `EnvService` is constructed. Overwriting it
 * here rather than passing a URL through is what keeps the production code free of
 * a test-only branch.
 */
export function disposableRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error(
      'TEST_REDIS_URL is unset. These tests delete the Redis keys they create, so the target ' +
        'has to be named explicitly rather than inherited from REDIS_URL.',
    );
  }
  process.env.REDIS_URL = url;
  return url;
}

/**
 * The migration role's URL: the table owner, for which RLS is inert.
 *
 * Needed only to provision and drop tenants. That is not a workaround — it is the
 * design: `rls_tenants_insert` permits an insert only when no tenant is in context
 * (signup), and there is deliberately *no* delete policy, because closing an account
 * is a platform-admin operation. So a test that wants a tenant has to do what the
 * signup service does, and a test that wants no leftovers has to do what an operator
 * does.
 *
 * Nothing under test may use this connection. Every assertion about approvals runs
 * on {@link applicationDatabaseUrl}, because RLS cannot make a row invisible to the
 * role that owns the table.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) {
    throw new Error(
      'DIRECT_DATABASE_URL is unset. Provisioning a test tenant needs the owner role: the app ' +
        'role may only insert a tenant when no tenant is in scope, and may not delete one at all.',
    );
  }
  return url;
}

/** The application role's URL: RLS is enforced against it. */
export function applicationDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      'APP_DATABASE_URL is unset. It must point at the non-owner role (orbitoz_app): a test that ' +
        'silently ran as the table owner would pass while proving nothing about RLS.',
    );
  }
  return url;
}
