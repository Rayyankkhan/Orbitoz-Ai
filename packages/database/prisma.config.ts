import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma 7+).
 *
 * The CLI no longer reads `package.json#prisma` nor auto-loads `.env`, so both
 * the schema path and the datasource URL are declared here.
 *
 * ENV LOADING
 *   This package lives at `packages/database` but the shared `.env` lives at the
 *   monorepo root, so the usual `import 'dotenv/config'` (which only looks in
 *   the CWD) silently finds nothing. Both locations are loaded, root first, and
 *   a package-local `.env` wins — that keeps a developer able to point one
 *   package at a scratch database without touching everyone's config.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <repo>/packages/database  ->  repo root is two levels up.
const repoRoot = path.resolve(here, '..', '..');

for (const candidate of [
  path.join(repoRoot, '.env'),
  path.join(repoRoot, '.env.local'),
  path.join(here, '.env'),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate, override: false, quiet: true });
  }
}

/**
 * `process.env` is read directly rather than through Prisma's `env()` helper.
 * Every CLI command loads this file — including `generate`, which must succeed
 * in CI where no database exists at all. `env()` throws on a missing variable
 * and would break `prisma generate` in the Docker build. `migrate` and
 * `db execute` surface an empty URL as a clear error on their own.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // DIRECT_ first: it bypasses any connection pooler, which Prisma Migrate
    // requires (it must be able to create and drop the shadow database).
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ?? '',
  },
});
