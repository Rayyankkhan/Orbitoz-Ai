import { defineConfig, globalIgnores } from 'eslint/config';
import { nextjs } from '@orbitoz/config/eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    '**/out/**',
    '**/next-env.d.ts',
    '**/.turbo/**',
  ]),
  ...nextjs,
]);
