# Documentation

## Architecture

- [Overview](architecture/overview.md) — system shape, request lifecycle, dependency direction
- [Multi-tenancy and RLS](architecture/multi-tenancy.md) — **read before changing any query**
- [Authentication](architecture/authentication.md) — sessions, tokens, and what a 409 from auth means

## Modules

- [`@orbitoz/database`](../packages/database) — schema, migrations, RLS, tenant-scoped client
- [`@orbitoz/ai-engine`](../packages/ai-engine) — provider routing, failover, structured output, workflows
- [`apps/api-gateway`](../apps/api-gateway) — HTTP edge
- [Auth module](modules/auth.md) — sign-in, sessions, and the guard
- [`apps/worker-service`](../apps/worker-service) — BullMQ consumer
- [Module 03 — BullMQ worker](MODULE_03_BULLMQ_WORKER.md) — tenant keyspaces, retries, DLQ, and recovery
- [Module 04 — AI orchestration](MODULE_04_AI_ORCHESTRATION.md) — provider routing, failover, structured output
- [Approval module](modules/human-approval.md) — parking a job for a human, and resuming it
- [Module 05 — Human-in-the-loop approvals](MODULE_05_HUMAN_APPROVAL.md) — capability links, signed decisions, resume
- [`apps/web`](../apps/web) — Next.js front end
- [`@orbitoz/shared-types`](../packages/shared-types) — branded IDs, enums, queue contracts
- [`@orbitoz/config`](../packages/config) — shared tsconfigs and ESLint presets

## Where to start

| If you are…                           | Read                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| adding a query                        | [multi-tenancy.md](architecture/multi-tenancy.md)                                                                      |
| adding a tenant-scoped model          | [multi-tenancy.md#adding-a-tenant-scoped-model)                                                                        |
| writing a gateway handler             | [api-gateway.md](modules/api-gateway.md)                                                                               |
| adding a protected route              | [auth.md](modules/auth.md)                                                                                             |
| changing sign-in or sessions          | [authentication.md](architecture/authentication.md)                                                                    |
| debugging a 401 or 409 from auth      | [authentication.md](architecture/authentication.md#error-codes)                                                        |
| writing a job processor               | [worker-service.md](modules/worker-service.md)                                                                         |
| changing provider routing or AI calls | [MODULE_04_AI_ORCHESTRATION.md](MODULE_04_AI_ORCHESTRATION.md)                                                         |
| approving a job by hand               | [human-approval.md](modules/human-approval.md)                                                                         |
| a 401 or 410 on an approval link      | [MODULE_05…md#the-link-is-a-capability](MODULE_05_HUMAN_APPROVAL.md#the-link-is-a-capability)                          |
| a job stuck at `AWAITING_APPROVAL`    | [MODULE_05…md#known-limitations](MODULE_05_HUMAN_APPROVAL.md#known-limitations)                                        |
| adding a route the gateway serves     | [human-approval.md](modules/human-approval.md#routes)                                                                  |
| recovering a dead-lettered job        | [MODULE_03…md#replay](MODULE_03_BULLMQ_WORKER.md#replay)                                                               |
| diagnosing cross-tenant job leakage   | [MODULE_03…md#tenancy-is-a-property-of-the-keyspace](MODULE_03_BULLMQ_WORKER.md#tenancy-is-a-property-of-the-keyspace) |
| changing the schema or RLS            | [database.md](modules/database.md)                                                                                     |
| adding a package                      | [overview.md](architecture/overview.md#adding-a-package)                                                               |
| getting a local environment running   | [../README.md](../README.md#quick-start)                                                                               |

## Commands worth knowing

| Command                   | Purpose                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `pnpm verify`             | generate → lint → typecheck → build                                |
| `pnpm test`               | unit tests across the workspace                                    |
| `pnpm test:integration`   | worker + approval integration tests (needs Redis **and** Postgres) |
| `pnpm db:verify`          | 30-check tenant isolation proof                                    |
| `pnpm db:setup`           | Database from empty: migrate → roles → RLS → seed                  |
| `pnpm scaffold --dry-run` | Preview app scaffolding                                            |
