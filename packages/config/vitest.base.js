/**
 * Shared Vitest configuration.
 *
 * Every package extends this so the same rules apply everywhere: one include
 * pattern, one coverage scope, one environment. A test that passes in
 * `shared-types` and fails in `database` because of a config difference is a
 * test suite nobody trusts.
 *
 * Why Vitest and not Jest: this workspace is native ESM with `NodeNext`
 * resolution, and the backend apps rely on `emitDecoratorMetadata` for Nest's
 * dependency injection. Jest needs `--experimental-vm-modules` for ESM, and its
 * TypeScript transform does not emit decorator metadata — which means Nest
 * cannot resolve any injected provider in a test. Vitest transforms through
 * Vite, which handles both natively.
 */

/** Default coverage thresholds, applied per package. */
const thresholds = {
  statements: 80,
  branches: 80,
  functions: 80,
  lines: 80,
};

/**
 * @param {object} [options]
 * @param {string[]} [options.include] Test file globs.
 * @param {string[]} [options.coverage] Source globs to measure coverage over.
 * @param {string} [options.environment] Vitest environment for the package.
 * @param {number} [options.threshold] Coverage threshold percentage.
 * @returns {import('vitest/config').ViteUserConfig}
 */
export function vitestBase({
  include = ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
  coverage = ['src/**/*.ts', 'src/**/*.tsx'],
  environment = 'node',
  threshold = thresholds.statements,
} = {}) {
  return {
    test: {
      environment,
      include,
      // `dist/` and `.next/` contain compiled copies of the same modules. Leaving
      // them in makes coverage report inflated numbers from stale build output.
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/coverage/**',
        // Prisma regenerates this on every `prisma generate`; testing generated
        // code tests Prisma, not this codebase.
        '**/src/generated/**',
      ],
      clearMocks: true,
      restoreMocks: true,
      // Surface an unhandled rejection as a test failure instead of a warning
      // printed after the run has already reported success.
      dangerouslyIgnoreUnhandledErrors: false,
      coverage: {
        provider: 'v8',
        reporter: ['text-summary', 'lcov'],
        include: coverage,
        // Test files and config entry points are never exercised by tests, so
        // counting them against the threshold only makes the number less honest.
        exclude: ['**/*.test.*', '**/*.spec.*', '**/*.config.*'],
        thresholds: {
          statements: threshold,
          branches: threshold,
          functions: threshold,
          lines: threshold,
        },
      },
    },
  };
}
