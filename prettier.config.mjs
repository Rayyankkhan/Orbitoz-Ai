// Root Prettier entry point.
// The canonical configuration lives in `packages/config` so every workspace
// package and any editor resolves the exact same rules. This file only
// re-exports it — edit `packages/config/prettier.config.mjs` to change style.
export { default } from './packages/config/prettier.config.mjs';
