# Documentation

## Architecture

- [Overview](architecture/overview.md) — system shape, request lifecycle, dependency direction
- [Multi-tenancy and RLS](architecture/multi-tenancy.md) — **read before changing any query**

## Modules

- [`@orbitoz/database`](../packages/database) — schema, migrations, RLS, tenant-scoped client
- [`apps/api-gateway`](../apps/api-gateway) — HTTP edge
- [`apps/worker-service`](../apps/worker-service) — BullMQ consumer
- [`apps/web`](../apps/web) — Next.js front end
- [`@orbitoz/shared-types`](../packages/shared-types) — branded IDs, enums, queue contracts
- [`@orbitoz/config`](../packages/config) — shared tsconfigs and ESLint presets

## Where to start

| If you are…                         | Read                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| adding a query                      | [multi-tenancy.md](architecture/multi-tenancy.md)        |
| adding a tenant-scoped model        | [multi-tenancy.md#adding-a-tenant-scoped-model)          |
| writing a gateway handler           | [api-gateway.md](modules/api-gateway.md)                 |
| writing a job processor             | [worker-service.md](modules/worker-service.md)           |
| changing the schema or RLS          | [database.md](modules/database.md)                       |
| adding a package                    | [overview.md](architecture/overview.md#adding-a-package) |
| getting a local environment running | [../README.md](../README.md#quick-start)                 |

## Commands worth knowing

| Command                   | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `pnpm verify`             | generate → lint → typecheck → build               |
| `pnpm db:verify`          | 21-check tenant isolation proof                   |
| `pnpm db:setup`           | Database from empty: migrate → roles → RLS → seed |
| `pnpm scaffold --dry-run` | Preview app scaffolding                           |
