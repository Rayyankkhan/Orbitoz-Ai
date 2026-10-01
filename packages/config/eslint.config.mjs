import { defineConfig, globalIgnores } from 'eslint/config';
import { base } from './base.js';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/coverage/**',
    '**/.next/**',
    '**/.turbo/**',
  ]),
  ...base,
]);
