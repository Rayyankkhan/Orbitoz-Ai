# Roadmap

Progress against [AUTOMATION_PROMPT.md](AUTOMATION_PROMPT.md). Read that file for
the full task list; this is the status index.

| Module | Scope                                      | Status        |
| ------ | ------------------------------------------ | ------------- |
| 00     | Monorepo & infrastructure                  | **COMPLETED** |
| 01     | Multi-tenant schema & PostgreSQL RLS       | **COMPLETED** |
| 02     | NestJS API gateway & JWT auth              | **COMPLETED** |
| 03     | Tenant-aware BullMQ & Redis worker         | **COMPLETED** |
| 04     | AI agent orchestration                     | **COMPLETED** |
| 05     | Human-in-the-loop webhooks & approvals     | **COMPLETED** |
| 06     | Stripe usage metering & billing            | Not started   |
| 07     | Next.js 16 multi-tenant dashboard          | Not started   |
| 08     | Production CI/CD, testing & VPS deployment | Not started   |

## Where the docs are

| Module | Document                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 00     | [README.md](README.md) — layout, quick start, commands                                                                                                                               |
| 01     | [docs/modules/database.md](docs/modules/database.md)                                                                                                                                 |
| 02     | [docs/modules/auth.md](docs/modules/auth.md), [docs/modules/api-gateway.md](docs/modules/api-gateway.md), [docs/architecture/authentication.md](docs/architecture/authentication.md) |
| 03     | [docs/MODULE_03_BULLMQ_WORKER.md](docs/MODULE_03_BULLMQ_WORKER.md), [docs/modules/worker-service.md](docs/modules/worker-service.md)                                                 |
| 04     | [docs/MODULE_04_AI_ORCHESTRATION.md](docs/MODULE_04_AI_ORCHESTRATION.md)                                                                                                             |
| 05     | [docs/MODULE_05_HUMAN_APPROVAL.md](docs/MODULE_05_HUMAN_APPROVAL.md), [docs/modules/human-approval.md](docs/modules/human-approval.md)                                               |

`AUTOMATION_PROMPT.md` lists a `docs/MODULE_XX_*.md` path per module. Modules 00–02
are documented under `docs/modules/` and `docs/architecture/` instead, which is
where they were actually written; the prompt's paths for those three were never
followed. Modules 03, 04 and 05 follow the prompt.

## Verification

| Command                 | Covers                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| `pnpm verify`           | generate → lint → typecheck → build                                               |
| `pnpm check`            | typecheck across every package                                                    |
| `pnpm test`             | unit tests, all packages                                                          |
| `pnpm test:integration` | worker + approval integration tests — needs `docker compose up -d redis postgres` |
| `pnpm db:verify`        | 30-check tenant isolation proof — needs Postgres                                  |

Integration tests are excluded from `pnpm test` rather than skipped, so the unit
suite stays runnable without infrastructure.

## Carried-forward known issues

Recorded so they are not rediscovered as bugs. Full detail in each module doc.

| Issue                                                                                             | Where                                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| No approval-expiry sweeper; an unopened expired link stays `PENDING` forever                      | [MODULE_05 § Known limitations](docs/MODULE_05_HUMAN_APPROVAL.md#known-limitations)   |
| Approval decisions record no named approver — `actor_id` is `null`                                | [MODULE_05 § Known limitations](docs/MODULE_05_HUMAN_APPROVAL.md#known-limitations)   |
| Nothing emails an approver or reminds them                                                        | [MODULE_05 § Known limitations](docs/MODULE_05_HUMAN_APPROVAL.md#known-limitations)   |
| Worker connection count scales linearly with tenants; `WORKER_MAX_TENANTS` is a connection budget | [MODULE_03](docs/MODULE_03_BULLMQ_WORKER.md#the-cost-stated-plainly)                  |
| Rate limiting is per worker replica, not global                                                   | [MODULE_03](docs/MODULE_03_BULLMQ_WORKER.md#known-limitations)                        |
| `DLQ_RETENTION_DAYS` is read but no sweeper enforces it                                           | [MODULE_03](docs/MODULE_03_BULLMQ_WORKER.md#known-limitations)                        |
| `refresh_tokens` has no primary key; cascade from `users` works, no migration drift               | [authentication.md](docs/architecture/authentication.md#known-database-defect)        |
| `AUTOMATION_PROMPT.md` says PostgreSQL 16; `docker-compose.yml` runs 18                           | [AUTOMATION_PROMPT.md](AUTOMATION_PROMPT.md)                                          |
| Only 6 of 9 catalogue providers have client implementations; the rest fail loudly                 | [MODULE_04 § Known limitations](docs/MODULE_04_AI_ORCHESTRATION.md#known-limitations) |
| Shipped credential store is env-only (one key per process, not per tenant)                        | [MODULE_04 § Known limitations](docs/MODULE_04_AI_ORCHESTRATION.md#known-limitations) |
| Local provider rate limiter is per worker replica, not global                                     | [MODULE_04 § Known limitations](docs/MODULE_04_AI_ORCHESTRATION.md#known-limitations) |
