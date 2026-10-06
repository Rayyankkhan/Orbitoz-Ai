import { defineConfig } from 'vitest/config';
import { vitestBase } from './vitest.base.js';

// Coverage over the shared ESLint presets. `tsconfig/**` is JSON, which the
// coverage remapper cannot parse, so it is deliberately not measured.
export default defineConfig(vitestBase({ coverage: ['eslint/**/*.js'] }));
