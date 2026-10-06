import { defineConfig, globalIgnores } from 'eslint/config';
import { library } from '@orbitoz/config/eslint';

export default defineConfig([
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/*.tsbuildinfo']),
  ...library,
  // Must come after the shared preset: flat config merges objects in order, so
  // the preset's `projectService` would otherwise win.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json', './tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
