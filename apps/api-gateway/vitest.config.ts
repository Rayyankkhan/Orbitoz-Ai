import { defineConfig } from 'vitest/config';
import { vitestBase } from '@orbitoz/config/vitest';

/**
 * Gateway tests are pure unit tests.
 *
 * There is no database connection anywhere in this suite. That is a deliberate
 * constraint rather than a shortcut: the interesting failures here are decisions —
 * which tenant was pinned, whether a decision was claimed atomically, whether an
 * enqueue sat inside a transaction — and each is decidable from the arguments a
 * service was called with. A test that needed Postgres to answer "was this approval
 * row read inside a tenant-pinned transaction" would be testing the mock.
 *
 * What RLS does at runtime is proved separately and for real, by `pnpm db:verify` in
 * packages/database; that Redis actually deduplicates a re-dispatched `jobId` is
 * proved in the worker's integration suite.
 */
export default defineConfig(
  vitestBase({
    include: ['src/**/*.test.ts'],
    // `approvals` and `queues` are here because the approval state machine is the
    // most stateful logic in this package and the one most likely to be refactored by
    // someone who did not read the module comment. Measuring it is what makes a
    // silent removal of a gate visible.
    coverage: ['src/auth/**/*.ts', 'src/config/**/*.ts', 'src/approvals/**/*.ts'],
  }),
);
