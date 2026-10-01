import { defineConfig } from 'vitest/config';
import { vitestBase } from '@orbitoz/config/vitest';

export default defineConfig(
  vitestBase({
    // `scripts/` holds the tenancy verification; unit tests for the scoping
    // logic live beside it.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: ['src/client/**/*.ts'],
  }),
);
