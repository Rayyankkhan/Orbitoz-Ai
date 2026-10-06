import { defineConfig, globalIgnores } from 'eslint/config';
import { library } from '@orbitoz/config/eslint';

export default defineConfig([
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/*.tsbuildinfo']),
  ...library,
  // Must come after the shared preset: flat config merges objects in order, so
  // the preset's `projectService` would otherwise win.
  {
    // Scoped to TypeScript so it does not apply to this .mjs file, which is not a
    // member of either project.
    files: ['**/*.ts'],
    // Two TypeScript projects: tsconfig.json builds src/ to dist/ and excludes
    // *.test.ts so tests stay out of the build, and tsconfig.eslint.json covers
    // those test files plus vitest.config.ts. ESLint's project service only
    // discovers tsconfig.json, so both are listed explicitly — otherwise the
    // contract tests fail to parse and go unlinted.
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json', './tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
