import { defineConfig, globalIgnores } from 'eslint/config';
import { library } from '@orbitoz/config/eslint';

export default defineConfig([
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/*.tsbuildinfo']),
  ...library,
]);
