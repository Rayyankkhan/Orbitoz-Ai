# Orbitoz AI

A multi-tenant AI platform. One deployment serves many customers; a request is
attributed to exactly one tenant, and Postgres—not application code—is the final
authority on that.

The interesting engineering problem in this repository is not the AI plumbing,
it is **making tenant isolation verifiable rather than assumed**. Most
multi-tenant bugs are invisible: a missing `WHERE tenant_id = ?` returns an empty
list, not an error, and it ships. Every design decision below follows from
making that class of mistake impossible, or at least loud.

## Stack

- **pnpm workspaces** + **Turborepo** — 3 apps, 3 libraries
- **PostgreSQL 18** with Row Level Security, enforced by a non-owner role
- **NestJS** (API gateway), **BullMQ** (worker), **Next.js** (web)
- **Prisma 7** with the `pg` adapter — no Rust query engine
- TypeScript ESM throughout; native ESM, `NodeNext` resolution

## Layout

```
apps/
  api-gateway/      NestJS HTTP edge: tenant resolution, auth, request tracing
  worker-service/   BullMQ consumer for inference jobs
  web/              Next.js app
packages/
  config/           Shared tsconfigs and ESLint presets (no runtime code)
  database/         Schema, migrations, RLS SQL, tenant-scoped Prisma client
  shared-types/     Branded IDs, enums, DTOs, queue contracts
scripts/
  scaffold.mjs      Generates app scaffolding
docs/
  architecture/     System design and the tenancy model
```

## Quick start

Prerequisites: Node 22+, pnpm 10+, Docker.

```bash
cp .env.example .env        # defaults match docker-compose.yml
docker compose up -d       # postgres, redis, mailpit
pnpm install
pnpm db:setup               # migrate -> roles -> RLS -> seed
pnpm verify                 # generate, lint, typecheck, build
pnpm db:verify              # prove tenants are isolated (21 checks)
```

`pnpm db:setup` seeds a demo tenant:

|          |                                |
| -------- | ------------------------------ |
| Tenant   | `https://acme.localhost:3000`  |
| Email    | `owner@acme.test`              |
| Password | `Password123!`                 |
| API key  | printed once by `pnpm db:seed` |

`localhost` subdomains resolve to `127.0.0.1` on most systems. If yours does
not, add `127.0.0.1 acme.localhost` to `/etc/hosts`.

## Commands

| Command                     | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `pnpm verify`               | generate → lint → typecheck → build. The gate.           |
| `pnpm check`                | format check + lint + typecheck. Faster pre-commit gate. |
| `pnpm db:setup`             | Full database bootstrap from empty.                      |
| `pnpm db:verify`            | End-to-end tenant isolation proof.                       |
| `pnpm db:studio`            | Prisma Studio.                                           |
| `pnpm scaffold -- <target>` | Regenerate app scaffolding. `--dry-run` to preview.      |
| `pnpm dev`                  | Run all apps in watch mode.                              |

Database scripts require `DIRECT_DATABASE_URL` (the owner role). Application
services use `DATABASE_URL` (the restricted role). See
[docs/architecture/multi-tenancy.md](docs/architecture/multi-tenancy.md) for why
that split exists — it is not redundant.

## The one rule that matters

**Application code runs as `orbitoz_app`, a non-owner role that does not bypass
Row Level Security.** The owner role exists only for migrations and the seed.

```sql
-- As orbitoz_app, outside a transaction pinned to a tenant:
SELECT * FROM conversations;
-- 0 rows. Not an error — which is exactly the problem.
```

RLS policies read a `app.tenant_id` GUC that is set transaction-locally, so it
cannot leak to the next request that borrows the connection. `PrismaService`
verifies enforcement at startup and refuses to serve traffic if it is off, and
the tenant extension refuses to run a scoped query outside a pinned transaction
rather than returning nothing.

Read [docs/architecture/multi-tenancy.md](docs/architecture/multi-tenancy.md)
before changing anything that touches a query.

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Multi-tenancy and RLS](docs/architecture/multi-tenancy.md)
- [API gateway](docs/modules/api-gateway.md)
- [Worker service](docs/modules/worker-service.md)
- [Database package](docs/modules/database.md)
