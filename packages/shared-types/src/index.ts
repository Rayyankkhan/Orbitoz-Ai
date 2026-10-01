/**
 * @orbitoz/shared-types — the only package that may be imported from both a
 * Node service and a browser bundle.
 *
 * Deliberately contains ZERO runtime dependencies: no Prisma, no Nest, no
 * class-validator, no zod. Anything framework-shaped lives in the service that
 * owns it, so importing this package never drags a server-only module into a
 * client bundle.
 */

/* Core primitives — branded ids, Result, cursor pagination */
export * from './core/index.js';

/* Enumerations and plan entitlements */
export * from './enums/index.js';

/* Request/response contracts */
export * from './dtos/index.js';

/* Multi-tenancy contracts and resolution rules */
export * from './tenancy/index.js';

/* Gateway <-> worker queue contracts */
export * from './queues/index.js';
