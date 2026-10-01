import next from 'eslint-config-next';
import nextTypeScript from 'eslint-config-next/typescript';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import { base } from './base.js';

/**
 * Flat ESLint config for `apps/web`.
 *
 * `eslint-config-next` ships its own flat config (Next.js 16), which already
 * wires @next/eslint-plugin-next, react, react-hooks and jsx-a11y. We layer the
 * repo-wide TypeScript strictness on top and finish with Prettier.
 */

// Defensive normalisation: `eslint-config-next` has shipped both a single
// object and an array across minor versions.
const asArray = (value) => (Array.isArray(value) ? value : [value]);

/** @type {import('eslint').Linter.Config[]} */
export const nextjs = [
  ...base,
  ...asArray(next),
  ...asArray(nextTypeScript),
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    linterOptions: {
      // Next's own rules ship their own inline disables; don't fail on them.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // RSC boundary: only 'use client' files may use these hooks.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-html-link-for-pages': ['error', 'apps/web/src/pages'],
      // The strictest TypeScript rules already cover unsafe React patterns,
      // and Next's JSX transform needs `React` in scope checks disabled.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    // Server-only modules must never be pulled into a client bundle.
    files: ['**/*.server.ts', '**/*.server.tsx', 'src/server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@orbitoz/database', 'pg', 'ioredis', 'bullmq'],
              message:
                'This is a server-only dependency. Do not import it from a client component.',
            },
          ],
        },
      ],
    },
  },
  prettier,
];

export default nextjs;
