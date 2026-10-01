# Architecture overview

## Request lifecycle

```
                    ┌──────────────────┐
   browser ────────▶│   apps/web       │  Next.js
                    └────────┬─────────┘
                             │ HTTPS
                    ┌────────▼─────────┐
   client ─────────▶│  apps/api-gateway│  NestJS
                    └────────┬─────────┘
                             │                    ┌──────────────────┐
                    ┌────────▼─────────┐           │  apps/worker-    │
                    │  Postgres (RLS)  │◀──────────│  service (BullMQ)│
                    └────────┬─────────┘           └──────────────────┘
                             │
                    ┌────────▼─────────┐
                    │      Redis       │  queues + BullMQ
                    └──────────────────┘
```

Inference is asynchronous. The gateway authenticates, validates, records an
`inference_jobs` row, and enqueues; the worker executes the provider call and
writes back results. A long-running model call never holds an HTTP request or a
database connection open.

## The three applications

### `apps/api-gateway`

The HTTP edge. Responsibilities, in order:

1. **Resolve the tenant** from the `Host` header, before any tenant data is
   touched. `TenantMiddleware` publishes the result as ambient scope.
2. **Authenticate** the principal. Tenant identity and authority are separate:
   resolving a host tells you _which tenant_, never _what the caller may do_.
3. **Execute** the request in a transaction with RLS pinned to that tenant.
4. **Enqueue** long-running work.

Never opens a transaction that spans the whole request — see
[multi-tenancy.md](multi-tenancy.md#transactions-are-the-unit-of-work).

### `apps/worker-service`

A plain Node process, not a Nest application. There is no HTTP surface, and
`@nestjs/bullmq` would add a container and a module graph to supervise a single
`Worker`. Revise if it grows scheduled jobs or needs an admin endpoint.

Tenancy crosses the process boundary in the job envelope. Every job carries
`tenantId`, and the worker establishes a fresh scope per job from that field —
never from ambient state, because there is none.

Queue names, job payloads, and retry policy live in
`@orbitoz/shared-types/queues`. The gateway produces and the worker consumes
from the same declarations, so a rename is a compile error in both at once. A
locally-defined copy would let a worker idle silently on a queue nobody writes to.

### `apps/web`

Next.js App Router, server-rendered. Resolves the tenant from the `Host` header
using the same subdomain rule as the gateway, so the two cannot disagree about
which tenant a request is for.

## The libraries

### `packages/database`

Owns the schema, migrations, RLS SQL, and the tenant-scoped Prisma client.

`PrismaService` composes rather than extends the generated client. Prisma 7
emits `PrismaClient` as an interface plus a construct signature, so `extends`
cannot produce a valid `super()` call; the service holds the client and re-exposes
each delegate instead. `this.prisma.conversation.findMany()` reads identically to
the subclassed form, but the extension cannot be bypassed by accident.

On startup it verifies RLS is actually enforced and **throws if it is not** —
see [multi-tenancy.md](multi-tenancy.md#why-the-owner-role-still-exists).

### `packages/shared-types`

Types only, no runtime dependencies. Holds branded IDs (`TenantId`, `JobId`), so
a `string` from a Redis payload cannot be passed where a `TenantId` is expected.
That is a compile error, not a runtime lookup failure on somebody else's data.

### `packages/config`

Shared tsconfigs and ESLint presets. No runtime code, so it can be depended on by
anything.

## Dependency direction

```
  apps/*  ──▶  shared-types
    │           database
    └───────────┘
```

Libraries never import from apps. `apps` depend on libraries; libraries depend on
nothing but each other and their external dependencies.

## Adding a package

```bash
# 1. Create the directory and package.json with a workspace:* dependency on
#    anything internal it needs.
# 2. Extend a tsconfig from @orbitoz/config.
# 3. Copy an existing package's eslint.config.mjs.
# 4. Declare the turbo tasks the new package supports (build/lint/typecheck).
```

`turbo.json` gates the pipeline on task names, not package names, so a new
package joins `pnpm verify` as soon as it defines those scripts.

## Environment variables

All configuration is validated through Zod at startup, in each app's
`src/config/env.ts`. A service with a missing or malformed variable exits during
bootstrap rather than failing later on the first request that touches it.

See `.env.example` for the full list. The database variables are covered in
[multi-tenancy.md](multi-tenancy.md).
