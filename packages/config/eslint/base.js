import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Baseline flat ESLint config shared by every workspace package.
 *
 * Layered model:
 *   base    — this file, framework agnostic strictness
 *   library — adds module-boundary rules for buildable shared packages
 *   nestjs  — relaxes decorator rules, adds Node globals
 *   nextjs  — layers `eslint-config-next` on top
 *
 * Every consumer finishes with `prettier` so formatting never fights linting.
 */

/** @type {import('eslint').Linter.Config[]} */
export const base = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
      // Prisma generated client — not ours to lint.
      '**/src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          // Each package's tsconfig only includes `src/**`, so the package's
          // own eslint.config.mjs is outside every TS project. Without this the
          // linter cannot parse the file it is configured by.
          allowDefaultProject: ['*.config.mjs', '*.config.ts'],
        },
        tsconfigRootDir: process.cwd(),
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // --- correctness -------------------------------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // --- style --------------------------------------------------------
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'object-shorthand': ['error', 'always'],
      'prefer-const': 'error',
      'no-return-await': 'error',
    },
  },

  {
    // Tests legitimately use non-null assertions, empty functions and mocks.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  prettier,
];

/** Buildable shared library package (packages/*). */
export const library = [
  ...base,
  {
    rules: {
      // Relative imports inside a package are an implementation detail; only
      // the package's public entry point may be imported from outside.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Single-level subpaths are the published surface of these
              // packages (`@orbitoz/database/client`, `@orbitoz/config/eslint`,
              // ...). Anything deeper is reaching into internals that carry no
              // compatibility promise.
              //
              // `@orbitoz/config/eslint/library` is the case that motivates
              // this: it reads like a public path, but the preset is only
              // supported through `@orbitoz/config/eslint`.
              group: [
                '@orbitoz/config/eslint/*',
                '@orbitoz/config/*/*',
                '@orbitoz/database/*/*',
                '@orbitoz/shared-types/*/*',
              ],
              message:
                'Import this workspace package through its public entry point only — never a deep path.',
            },
          ],
        },
      ],
    },
  },
];

/** NestJS service (apps/*). */
export const nestjs = [
  ...base,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // TypeScript's legacy `experimentalDecorators` emit is what Nest's
      // DI container reflects over; the ES decorators plugin rules conflict.
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',

      // Nest convention: DI providers take zero-arg constructors and read
      // configuration through ConfigService, not process.env.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@orbitoz/config/eslint/*',
                '@orbitoz/config/*/*',
                '@orbitoz/database/*/*',
                '@orbitoz/shared-types/*/*',
              ],
              message:
                'Only the published subpath of a package may be imported, never its internals.',
            },
          ],
        },
      ],
    },
  },
];

/** Next.js app (apps/web). */
export const nextjs = [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/next-env.d.ts',
      '**/src/generated/**',
    ],
  },
];

export default base;
