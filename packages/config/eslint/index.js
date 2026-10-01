/**
 * The public entry point for ESLint configuration.
 *
 * Consumers import presets from here — `@orbitoz/config/eslint` — rather than
 * reaching into `eslint/library` or `eslint/nestjs`. The per-preset modules are
 * implementation detail: a preset can be renamed, split, or merged into the
 * shared base without touching a single package's config.
 *
 * The deep-path restriction exists so that a workspace package's public surface
 * stays the only supported entry point, and this file is that surface.
 */
export { base, library, nestjs, nextjs } from './base.js';
