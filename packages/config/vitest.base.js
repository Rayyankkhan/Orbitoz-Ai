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

/**
 * The Vitest options this helper owns. Everything else the caller passes is
 * forwarded to `test` untouched, so per-package knobs like `pool`,
 * `fileParallelism`, `poolOptions`, `testTimeout` and `hookTimeout` actually
 * reach Vitest instead of being silently dropped.
 *
 * @param {object} [options]
 * @param {string[]} [options.include] Test file globs.
 * @param {string[]} [options.coverage] Source globs to measure coverage over.
 * @param {string[]} [options.coverageExclude] Extra coverage exclusion globs.
 * @param {string} [options.environment] Vitest environment for the package.
 * @returns {import('vitest/config').ViteUserConfig}
 */
export function vitestBase(options = {}) {
  const {
    include = ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    coverage = ['src/**/*.ts', 'src/**/*.tsx'],
    coverageExclude = [],
    environment = 'node',
    ...testOptions
  } = options;

  return {
    test: {
      // Forwarded first so the keys this helper computes below always win.
      ...testOptions,
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
        // Test files and config entry points are never exercised by tests;
        // packages add their own process wiring (e.g. `main.ts`) here.
        exclude: ['**/*.test.*', '**/*.spec.*', '**/*.config.*', ...coverageExclude],
        // Coverage is reported, not enforced. A threshold the workspace cannot
        // clear yet is a gate that teaches people to pass `--coverage=false`,
        // not one that raises quality; add one when the tests exist to hold it.
      },
    },
  };
}
