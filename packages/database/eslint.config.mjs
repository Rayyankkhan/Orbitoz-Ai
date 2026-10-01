import { defineConfig, globalIgnores } from 'eslint/config';
import { library } from '@orbitoz/config/eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.turbo/**',
    '**/*.tsbuildinfo',
    // Prisma output. Regenerated on every `prisma generate`, so linting it
    // would report problems in code nobody edits and that is overwritten on the
    // next build. It is still typechecked via tsconfig.
    'src/generated/**',
  ]),
  ...library,
  // Must come after the shared preset: flat config merges objects in order, so
  // the preset's `projectService` would otherwise win.
  {
    // Scoped to TypeScript so it does not apply to this .mjs file, which is not
    // a member of either project.
    files: ['**/*.ts'],
    // This package has three TypeScript projects: tsconfig.json builds src/ to
    // dist/, tsconfig.scripts.json checks prisma.config.ts, the seed and the
    // tenancy verification, and tsconfig.eslint.json covers the test files and
    // vitest.config.ts that both of the others deliberately exclude. ESLint's
    // project service only discovers tsconfig.json, so all three are listed
    // explicitly — otherwise the files in the other projects fail to parse and
    // go unlinted.
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json', './tsconfig.scripts.json', './tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The seed and the tenancy verification are command-line tools: writing to
    // stdout is their entire output contract, and it is what CI reads. The
    // no-console rule exists to stop stray logging leaking into service output,
    // which does not apply here.
    files: ['prisma/seed.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
]);
