# Module 03 — Tenant-Aware BullMQ & Redis Worker Microservice

Status: **COMPLETED**

The module's single claim: **one tenant's jobs can never be consumed by another
tenant's worker.** Everything else here — retries, the DLQ, context propagation,
shutdown — exists to keep that claim true in the presence of failure. A queue
system that loses a job is an outage; one that hands tenant A's prompt to tenant B
is a breach.

Implemented in `apps/worker-service`, with contracts in
`packages/shared-types/src/queues/job.contracts.ts`. See
[modules/worker-service.md](modules/worker-service.md) for the maintainer's view.

## Requirements, and what was actually done

| Spec task                                                                       | Outcome                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize the worker app in `apps/worker-service`                              | Done. A plain Node process, not a Nest application — see [Why not Nest](#why-not-nest).                                                                                                             |
| BullMQ producer in `api-gateway`, consumer in `worker-service`, namespaced keys | **Done, producer in Module 05.** `WORKER_MAX_TENANTS` and one queue per tenant per queue-type is a real cost, so the producer landed with the first route that had real work to enqueue: approvals. |
| Exponential backoff, retries, DLQ                                               | Done. 4 total attempts (1 + 3 retries), exponential from 1s, `jitter: 0.5`. `dlq`, one per tenant.                                                                                                  |
| Vitest integration harness proving isolation and context                        | Done. 18 tests against live Redis.                                                                                                                                                                  |
| Tests for retry, failure handling, tenant isolation                             | Done. 52 unit tests plus the 18 integration tests.                                                                                                                                                  |

### Deviations from the spec text, and why

Three places where following the prompt literally would have produced something
worse. All three are recorded here rather than quietly implemented.

**`dlq-queue` → `dlq`.** The spec names the queue `dlq-queue`. It is `dlq`. The
prefix already carries the namespace, so `orbitoz:{<tenant>}:queue:dlq` reads
correctly and the hyphen was noise.

**`orbitoz:{tenantId}:queue:{queueName}` → prefix + bare name.** The documented
_key shape_ is honoured exactly: keys look like
`orbitoz:{<tenantId>}:queue:<queueName>:<type>`. But BullMQ **throws** if a
queue name contains a colon, so `{queueName}` cannot be part of the name. The
tenant namespace goes in the `prefix` option and the queue name stays bare; the
key shape is the same string either way. An integration test asserts the literal
prefix shape against real Redis keys, so this is checked rather than asserted in
prose.

**"3 attempts" → 4.** BullMQ's `attempts` counts total tries. Three total tries
is two retries; the prompt's intent (three retries) is `attempts: 4`. The spec's
"Dead Letter Queue" also did not say where DLQ entries live; they live per
tenant, for the isolation reason above.

## Tenancy is a property of the keyspace

```
orbitoz:{<tenantId>}:queue:ai-inference:wait
orbitoz:{<tenantId>}:queue:dlq:1
```

A worker subscribed to tenant A's prefix cannot see tenant B's backlog, cannot
consume from it, and cannot be configured to. Isolation lives in Redis rather
than in a field a processor must remember to check — the same reasoning as the
RLS layer from Module 01: prefer a boundary the mistake cannot cross over one the
mistake must avoid.

Braces are literal, not Redis Cluster hash tags. They make the namespace
greppable in `redis-cli --scan` and make `{tenantId}` visibly a substitution
point.

`assertTenantIdShape` rejects a tenant id containing `:` `{` `}` or whitespace
before it becomes a key. The id arrives from an untrusted payload restored from
Redis; without the check a forged id could construct a key that reads another
tenant's namespace.

### The cost, stated plainly

One queue per tenant per queue-type means a worker serving _T_ tenants on one
queue-type holds **2*T* blocking connections**. `WORKER_MAX_TENANTS` (50) is a
connection budget, not a politeness setting, and the worker refuses new tenants
past it rather than opening sockets until Redis refuses them. At defaults:
4 queue-types × 50 tenants × 2 = 400 connections per replica, against Redis's
`maxclients` of 10,000. **Scale out with more replicas; do not raise the cap to
compensate.** This is the main operational constraint of the design and the
first thing to revisit if queue latency looks bad under load.

## Queues

| Queue                   | Processor                       | Work                     |
| ----------------------- | ------------------------------- | ------------------------ |
| `ai-inference`          | `InferenceProcessor`            | Workflow / AI execution  |
| `usage-aggregation`     | `UsageAggregationProcessor`     | Usage rollup — module 06 |
| `tenant-provisioning`   | `TenantProvisioningProcessor`   | Post-signup setup steps  |
| `notification-dispatch` | `NotificationDispatchProcessor` | Outbound notifications   |
| `dlq`                   | operator, never automatic       | Terminal failures        |

`WORKER_QUEUES` deliberately excludes `dlq`, and a test asserts the exclusion. A
DLQ entry consumed automatically would fail again and be dead-lettered a second
time — an infinite loop on one poison entry — and it would burn the single DLQ
attempt budget while an operator is still trying to diagnose it. No DLQ processor
exists in `queue-processors.ts`, and the file says so in a comment.

The three non-inference processors log and complete. Their real work belongs to
later modules, and they say so in their log lines. A job marked complete for a
side effect that never happened is worse than a job that fails and retries,
because the failure looks like success to everything downstream.

## The envelope

```ts
interface BaseJob<T> {
  id: string;
  tenantId: string;
  userId: string | null; // null for system-initiated jobs
  traceId: string;
  enqueuedAt: string;
  attempt: number;
  payload: T;
}
```

`userId` is nullable because usage rollups and tenant provisioning are not caused
by a person; `tenantId` and `traceId` are not, because a job without them has no
safe interpretation. `validateJobContext` reports **every** problem at once — an
operator reading a DLQ entry should see the whole list, not fix one field per
deploy.

`withJobContext` maps the envelope onto the ambient scope the Prisma extension
reads, with `traceId` becoming the scope's `requestId`, so a job's log lines join
up with the request that enqueued it. It is declared `async` deliberately: a
non-async function that throws before its first `await` throws _synchronously_,
so a caller writing `withJobContext(job, fn).catch(handle)` would get an uncaught
exception that escapes the worker's own try/catch.

Adding an envelope field means adding it **optional, forever**. A job enqueued
before a deploy must still process after it.

## Retries and the Dead Letter Queue

```
try 1 → immediately
try 2 → 1s   (±50% jitter)
try 3 → 2s   (±50% jitter)
try 4 → 4s   ← still fails, job is routed to that tenant's DLQ
```

Jitter is not decoration. Without it, a provider blip that stalls a hundred
tenants fails all hundred workflows on the same millisecond and retries them in
lockstep, re-creating the overload that caused the failure. The consequence is
that the documented schedule is approximate, and a test asserting exact delays
would be testing the wrong thing.

A processor marks a failure terminal by throwing an error with `retryable: false`.
The worker rethrows it as an `UnrecoverableError`, and BullMQ moves the job
straight to the failed set with `attemptsMade: 1` — no three further attempts,
and no operator waiting out the backoff schedule for a validation error.

### DLQ routing happens in the `failed` event

This is the module's subtlest bug and the reason the integration suite exists.

BullMQ increments `attemptsMade` **after** the processor rejects. A `catch` block
inside the processor therefore sees the _pre-increment_ count: on the fourth and
final attempt it reads 3 of 4, concludes the budget is not spent, and returns. The
job then lands in BullMQ's failed set with **no DLQ entry at all** — a silent
failure that looks like a successful retry policy in every log line.

The `failed` event fires after the increment. It is the only place the terminal
attempt count is observable, so it is where routing lives. Two tests exist purely
to pin this: one asserting a DLQ entry appears after the final attempt, one
asserting a DLQ job gets `attempts: 1` and cannot loop.

`decideDeadLetter` handles three cases in priority order:

1. **No tenant id** → not dead-lettered. The DLQ is per-tenant; filing an
   unattributable job in an arbitrary tenant's DLQ would be a lie about where it
   came from. BullMQ's failed set is the only record.
2. **Non-retryable failure** → straight to the DLQ, budget skipped.
3. **Budget exhausted** → DLQ.

It is pure and synchronous, so the policy is unit-testable with no Redis.

DLQ entries retain `removeOnFail: false` until an operator acts, and carry the
original envelope in full — the source queue may already have trimmed it, and a
replay needs the payload to restore the job exactly.

### Replay

`replayDeadLetter(registry, entry, foundInTenant)` requires the caller to name the
DLQ the entry was read from and refuses a mismatch against the envelope's own
`tenantId`. Without that check, an entry edited in Redis could replay work into
an arbitrary tenant's namespace while appearing to clear a backlog. There is a
test for exactly that, plus one for an entry with no tenant at all.

Replay is always an explicit operator action. Recovery is a deliberate act, never
a timer.

## Graceful shutdown

`SIGTERM` drains; `SIGINT` drains; a **second** signal exits immediately, because
an operator who sends `SIGTERM` twice means stop now.

`TenantWorker.onModuleDestroy` calls `worker.close()`, which pauses first: an
in-flight job finishes, a queued one stays in Redis for the next process. Without
the pause BullMQ marks the in-flight job stalled and hands it to another worker
while the original still runs — how one deploy produces duplicate side effects.

- **Concurrent**, not sequential. Sequential draining makes shutdown time the sum
  of every job's runtime; a deploy with a 10-minute timeout cannot afford that.
- **Bounded** by `DRAIN_TIMEOUT_MS` (25s). On timeout the worker is force-closed
  and remaining jobs are left for BullMQ's stalled-job checker, so an operator
  can see them in the failed set — better than a container that never exits and
  gets `SIGKILL`ed.
- **Ordered**: drain workers → close queues → disconnect database and Redis.
  Closing Redis mid-drain turns "the job finishes" into "the job fails on a
  closed connection".

## Redis connections

Two facts about the installed driver drove these decisions:

- BullMQ needs `maxRetriesPerRequest: null` on any connection used for a blocking
  command. Left at ioredis's default, a worker fails at startup with a timeout
  that reads like a Redis outage — Redis is fine, and the worker's own blocking
  call exhausted the budget.
- **ioredis 6 removed the per-client connection pool.** `maxConnections` is still
  accepted into `options` and silently ignored; one `Redis` instance is exactly
  one TCP connection. Verified against 6.0.0.

There is therefore no pool-size setting, and adding one would be a knob that
reads like a control and does nothing. Connection count is bounded by
`WORKER_MAX_TENANTS` instead.

One factory, `createQueueRedisConnection`, carries a 10s command timeout. There is
no separate blocking variant: BullMQ strips `commandTimeout` from the client it
duplicates for blocking, so a connection built with a timeout is safe to hand
directly to a `Worker`, and a second factory would have implied a distinction the
driver does not make.

## Why not Nest

The spec asks for a NestJS microservice. It is a plain Node process. There is no
HTTP surface, no DI graph to wire, and `@nestjs/bullmq` would add a container and
module system in order to supervise a `Map<tenantId, Worker>`. The Nest symbols
borrowed are `Logger` and `OnModuleDestroy` — the latter because drain-on-shutdown
is real lifecycle management deserving an interface rather than a hand-rolled
`process.on` block.

Revisit if the worker gains scheduled jobs or an admin endpoint.

## Tenant discovery

Tenants are not known until they exist, so the worker re-reads the `tenants` table
every `WORKER_TENANT_REFRESH_INTERVAL_MS` (30s) and subscribes any new ones.

A poll rather than pub/sub: the database is the authority on which tenants exist,
so a worker that starts after a tenant was created has no notification to
receive. Cost is one indexed `SELECT id` per interval; cost of getting it wrong is
a tenant's jobs sitting unconsumed until the next deploy.

## Tests

**Unit — 52 tests, no Redis, no database** (`pnpm test`)

| File                          | Covers                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| `queues/tenant-queue.test.ts` | prefix shape, namespace suffix, tenant id rejection, DLQ job options  |
| `context/job-context.test.ts` | envelope validation, scope propagation, no leaked scope, retryability |
| `queues/dead-letter.test.ts`  | `decideDeadLetter` priority order, payload shape, replay guards       |

**Integration — 18 tests, live Redis** (`pnpm test:integration`)

| File                                   | Covers                                                                                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant-isolation.integration.test.ts` | distinct keyspaces; a worker on A never consumes B's job; one job to one of two workers; per-tenant DLQs; the literal prefix shape in real Redis keys                                                                                  |
| `dlq-routing.integration.test.ts`      | 4 attempts then DLQ; the entry on the failing job's own tenant; DLQ gets 1 attempt; non-retryable skips the budget; replay returns it to its source queue under its own tenant; replay refuses a tenant mismatch and refuses no tenant |
| `tenant-context.integration.test.ts`   | tenant/user/trace available in the processor; correct scope across concurrent jobs; no scope left behind; a payload claiming no tenant never reaches the processor                                                                     |

`packages/shared-types` adds 6 contract tests, so a producer and a consumer cannot
disagree about the envelope without a compile error.

### Harness design

These tests are about Redis keyspaces, so they need real Redis and real BullMQ. A
mocked queue would let a test pass while tenant A's worker consumed tenant B's
job, because a mock has no keyspace to be wrong about. That is the entire claim
under test; faking it would prove nothing.

- **A per-run id in every namespace.** Two concurrent vitest workers, a stale
  keyspace from a crashed run, and a developer's own local queues all coexist.
- **Random UUID tenants.** A leftover keyspace from an aborted run cannot be
  mistaken for a fresh one.
- **`TEST_REDIS_URL`, separate from `REDIS_URL`.** The harness deletes keys, and
  that is only acceptable against something disposable.
- **Batched `SCAN` + `UNLINK` cleanup, scoped to the run's own namespace.** Never
  `KEYS`, which blocks the Redis event loop for the length of the keyspace; never a
  wildcard, which on a shared Redis would delete someone else's queue.
- **Production wiring, mirrored deliberately.** Producers and consumers resolve
  their prefix from the same place, and processors run inside `withJobContext` for
  job queues. Both were wrong in the first draft, and both failed _silently_
  rather than loudly — a harness that diverges from production produces a green
  suite that tests a worker nobody ships.

Integration tests are excluded from the unit config rather than skipped, and run
serialized. `pnpm verify` therefore stays meaningful without Redis, and
`pnpm test:integration` is explicit about needing it.

## Configuration

| Variable                            | Default                  | Notes                                                   |
| ----------------------------------- | ------------------------ | ------------------------------------------------------- |
| `REDIS_URL`                         | `redis://localhost:6379` | Repository uses a URL, not a port                       |
| `TEST_REDIS_URL`                    | `redis://localhost:6379` | Integration only; the harness deletes keys              |
| `WORKER_CONCURRENCY`                | `10`                     | Per tenant, per queue-type                              |
| `WORKER_MAX_TENANTS`                | `50`                     | Connection budget; see above                            |
| `WORKER_TENANT_REFRESH_INTERVAL_MS` | `30000`                  | Tenant table poll                                       |
| `WORKER_RATE_LIMIT_MAX`             | `50`                     | Aggregate across all tenants                            |
| `WORKER_REDIS_COMMAND_TIMEOUT_MS`   | `10000`                  | Producer connections only                               |
| `DLQ_RETENTION_DAYS`                | `30`                     | Observability and replay tooling                        |
| `DATABASE_URL` / `APP_DATABASE_URL` | —                        | Must be `orbitoz_app`; startup fails if RLS is bypassed |

DLQ routing itself is decided in code by `decideDeadLetter`, not by configuration,
so a config change cannot silently stop dead-lettering.

## Operational notes

**Inspecting a tenant's backlog**

```bash
redis-cli --scan --pattern 'orbitoz:{<tenantId>}:queue:*'
```

**Inspecting the DLQ** — read, do not consume. A `Worker` on the DLQ would defeat
its purpose.

**Replaying** — via `replayDeadLetter`, passing the namespace the entry was read
from. Do not hand-copy jobs between namespaces with `redis-cli`; the tenant guard
exists because that copy is exactly where cross-tenant damage enters.

## Known limitations

- ~~**No producer in `api-gateway` yet.**~~ Closed by Module 05, which added
  `QueueProducer` as the resume path for approved jobs and reviewed it against the
  connection cost above. See
  [MODULE_05](MODULE_05_HUMAN_APPROVAL.md).
- **Connection cost scales linearly with tenants** (see the keyspace section).
- **Rate limiting is per worker process, not global.** `WORKER_RATE_LIMIT_MAX` is
  enforced by BullMQ's `limiter` inside each replica, so N replicas admit N× the
  configured rate. A global limit needs a shared counter.
- **`InferenceProcessor` is a contract, not an LLM client.** Real provider routing
  is Module 04.
- **Non-inference processors log and complete.** Real behaviour is Module 05/06.
- **DLQ retention is not enforced by a sweeper.** `DLQ_RETENTION_DAYS` is read for
  observability; entries keep until an operator removes them. A cron sweep is
  module 08 work.

## Related

- [modules/worker-service.md](modules/worker-service.md) — maintainer's guide
- [architecture/multi-tenancy.md](architecture/multi-tenancy.md) — the RLS layer
  this module's keyspaces mirror
- [../AUTOMATION_PROMPT.md](../AUTOMATION_PROMPT.md) — roadmap
