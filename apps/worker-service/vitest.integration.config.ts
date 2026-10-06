import { defineConfig } from 'vitest/config';
import { vitestBase } from '@orbitoz/config/vitest';

/**
 * Integration tests: real BullMQ against a real Redis.
 *
 * These are the only tests in the repo that can prove the module's central claim,
 * which is about Redis keyspaces — that a worker subscribed to tenant A's queue
 * cannot consume tenant B's job, that a job exhausting its retries lands on its
 * own tenant's DLQ, and that a payload's tenant reaches a processor as ambient
 * scope. A mock has no keyspace to be wrong about, so these claims cannot be
 * established any other way.
 *
 * Needs a live Redis on `TEST_REDIS_URL` (default `redis://localhost:6379`).
 * Start it with `docker compose up -d redis`.
 *
 * `TEST_REDIS_URL` is intentionally separate from `REDIS_URL`. These tests delete
 * keys, so pointing them at a shared or staging instance would be destructive; the
 * distinct name makes the disposable target explicit.
 *
 * `fileParallelism` is off and `pool: 'forks'` with a single fork. Two files
 * running at once would each build their own harness, and while the per-run
 * namespace keeps their *keys* apart, two files racing to `SCAN`-and-delete would
 * add avoidable contention against the shared Redis for no time saved — these
 * suites take seconds.
 */
export default defineConfig(
  vitestBase({
    include: ['test/**/*.test.ts'],
    coverage: ['src/**/*.ts'],
    // Serialized: see above. Also what makes the per-assertion timeouts in these
    // files predictable, since nothing else competes for the event loop.
    fileParallelism: false,
    pool: 'forks',
    // `maxWorkers: 1` is belt-and-braces: `fileParallelism: false` already pins it
    // to 1, but stating it makes the intent legible. There is deliberately no
    // `minWorkers` — Vitest 5 removed it along with `poolOptions.forks.singleFork`,
    // and passing it was being silently dropped.
    maxWorkers: 1,
    // BullMQ's backoff is real Redis state, so fake timers cannot substitute for
    // it. The suites shorten their own backoff to milliseconds instead, and give
    // the slow ones a generous ceiling for a loaded CI box.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  }),
);
