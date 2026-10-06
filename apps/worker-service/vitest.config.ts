import { defineConfig } from 'vitest/config';
import { vitestBase } from '@orbitoz/config/vitest';

/**
 * Unit tests only: the pure logic, with no Redis and no database.
 *
 * Deliberately scoped to `src/`. `pnpm test` runs this, so it must stay runnable
 * anywhere — no container, no `TEST_REDIS_URL`, no fixtures to start. The
 * integration tests live behind `vitest.integration.config.ts` and
 * `pnpm test:integration`, which is what lets `pnpm verify` stay meaningful on a
 * machine with no Redis.
 *
 * Coverage is measured here and not in the integration run, because the
 * integration run exists to prove the keyspace behaves as designed; a coverage
 * number taken across two suites with different execution environments is
 * harder to read than one taken from the deterministic suite.
 */
export default defineConfig(
  vitestBase({
    include: ['src/**/*.test.ts'],
    coverage: ['src/**/*.ts'],
    // `src/main.ts` is process wiring: it builds a real Prisma client, opens Redis
    // connections, and installs signal handlers. Exercising it means starting the
    // service, which no unit test should do — so it is excluded rather than
    // counted as uncovered.
    coverageExclude: ['**/main.ts'],
  }),
);
