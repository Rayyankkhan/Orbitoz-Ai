/**
 * Canonical Prettier configuration for the Orbitoz AI monorepo.
 *
 * Re-exported by the repo-root `prettier.config.mjs`. Import it directly with:
 *   import prettier from '@orbitoz/config/prettier'
 */
export default {
  arrowParens: 'always',
  bracketSameLine: false,
  bracketSpacing: true,
  endOfLine: 'lf',
  experimentalOperatorPosition: 'end',
  printWidth: 100,
  proseWrap: 'preserve',
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'all',
  useTabs: false,
  // Prisma files are formatted by `prisma format`, not Prettier.
  overrides: [
    {
      files: ['*.json', '*.jsonc'],
      options: { printWidth: 80, trailingComma: 'none' },
    },
  ],
};
