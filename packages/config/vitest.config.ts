import { defineConfig } from 'vitest/config';
import { vitestBase } from './vitest.base.js';

export default defineConfig(vitestBase({ coverage: ['eslint/**/*.js', 'tsconfig/**/*.json'] }));
