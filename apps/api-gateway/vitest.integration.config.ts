import { defineConfig } from 'vitest/config';
import { vitestBase } from '@orbitoz/config/vitest';

/**
 * Integration tests: the real approval state machine against real Postgres and
 * real Redis.
 *
 * `src/approvals/approval.service.test.ts` proves the *decisions* — which
 * transaction ran, in what order, whether an enqueue was attempted. It cannot
 * prove the two facts that only a database and a queue can be wrong about:
 *
 *   - that the approval row really is invisible to another tenant once RLS is
 *     applied, rather than merely filtered by a `where` clause that a later
 *     refactor could drop;
 *   - that re-dispatching an approved job is deduplicated by BullMQ on `jobId`,
 *     which is the only thing standing between a crash in the commit/enqueue
 *     window and a job running twice.
 *
 * Those are claims about two services' behaviour, so they are made here against
 * both for real. A mock has neither a keyspace nor a policy to be wrong about.
 *
 * Needs Postgres with migrations applied and RLS enabled (`pnpm db:setup`), plus
 * a Redis on `TEST_REDIS_URL` (`docker compose up -d redis`).
 *
 * `TEST_REDIS_URL` is deliberately not `REDIS_URL`. These tests delete the keys
 * they create; pointing that at a shared instance would be destructive. The
 * distinct name makes the disposable target explicit. See `test/support/redis.ts`
 * for why deleting a whole tenant namespace is still safe to do here.
 *
 * Serialized, like the worker's integration config: each file opens its own
 * Prisma pool and its own Redis connections, and these suites take seconds.
 */
export default defineConfig(
  vitestBase({
    include: ['test/**/*.test.ts'],
    coverage: ['src/approvals/**/*.ts', 'src/queues/**/*.ts'],
    fileParallelism: false,
    pool: 'forks',
    // `maxWorkers: 1` is belt-and-braces: `fileParallelism: false` already pins it
    // to 1, but stating it makes the intent legible. There is deliberately no
    // `minWorkers` — Vitest 5 removed it along with `poolOptions.forks.singleFork`,
    // and passing it was being silently dropped.
    maxWorkers: 1,
    // Every assertion here round-trips Postgres and Redis, so the per-test ceiling is
    // the sum of those latencies rather than one of them. Generous because a loaded
    // CI box sharing Postgres with a migration is the normal case, not the failure.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  }),
);
