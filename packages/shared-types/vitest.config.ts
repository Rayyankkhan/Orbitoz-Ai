import { defineConfig } from 'vitest/config';
import { vitestBase } from '@orbitoz/config/vitest';

export default defineConfig(vitestBase({ coverage: ['src/**/*.ts'] }));
