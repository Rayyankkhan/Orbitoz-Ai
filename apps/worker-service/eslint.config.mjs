import { defineConfig, globalIgnores } from 'eslint/config';
import { nestjs } from '@orbitoz/config/eslint';

export default defineConfig([
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/*.tsbuildinfo']),
  ...nestjs,
  // Must come after the shared preset: flat config merges objects in order, so
  // the preset's `projectService` would otherwise win.
  {
    // Scoped to TypeScript so it does not apply to this .mjs file, which is not a
    // member of either project.
    files: ['**/*.ts'],
    // Two TypeScript projects: tsconfig.json builds src/ to dist/ and excludes
    // *.test.ts so tests stay out of the build, and tsconfig.eslint.json covers
    // those test files plus vitest.config.ts. ESLint's project service only
    // discovers tsconfig.json, so both are listed explicitly — otherwise the test
    // suite fails to parse and goes unlinted.
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json', './tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test doubles deliberately ignore arguments they do not assert on, and
    // fake timers are the whole point of the retry/backoff tests.
    files: ['src/**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Off here, on in src. A worker processor must return `Promise<void>` to
      // satisfy `TenantJobProcessor` and BullMQ's own signature, so a test's
      // recording-only processor is written `async` with no `await` inside. In
      // application code that pattern is a smell worth flagging — an `async`
      // function that never awaits is usually a forgotten await — but here the
      // async keyword is carrying a return type, not an intention to suspend.
      '@typescript-eslint/require-await': 'off',
    },
  },
]);
