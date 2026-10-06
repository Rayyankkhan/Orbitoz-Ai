# `apps/worker-service`

Tenant-aware BullMQ consumer. One process supervises a `Worker` per
`(queue-type, tenant)` pair, establishes the tenant's scope per job, and files
terminal failures on that tenant's Dead Letter Queue.

## Tenancy is a property of the keyspace

The central design decision. Every Redis key for a job is
`<prefix>:<queueName>:<type>`, and BullMQ rejects a queue name containing a colon
— so the tenant namespace goes in the `prefix` option and the queue name stays
bare:

```
orbitoz:{<tenantId>}:queue:ai-inference:wait
orbitoz:{<tenantId>}:queue:dlq:1
```

A worker subscribed to tenant A's keys cannot see tenant B's backlog, cannot
consume from it, and cannot be configured to. Isolation lives in Redis rather than
in a field a processor has to remember to check — the same reasoning as the RLS
layer: prefer a boundary the mistake cannot cross over one the mistake must avoid.

The cost is real, and stated plainly: **one queue per tenant per queue-type**. A
worker serving _T_ tenants on one queue-type holds _2T_ blocking connections,
because BullMQ opens a blocking client and a command client per `Worker`.
`WORKER_MAX_TENANTS` is really a connection budget and the worker refuses new
tenants past it rather than opening sockets until Redis refuses them. Scale out
with more replicas; do not raise the cap to compensate.

Two related guards, both defence in depth rather than the primary boundary:

- `assertTenantIdShape` rejects a tenant id containing `:` `{` `}` or whitespace
  before it becomes a key. A tenant id reaches this code from an untrusted payload
  in Redis, and a forged one could construct a key that reads another tenant's
  namespace.
- `replayDeadLetter` requires the caller to name the DLQ the entry was read from
  and refuses a mismatch against the envelope's own `tenantId`. Without that check
  a DLQ entry edited in Redis could replay work into an arbitrary tenant's
  namespace while appearing to clear a backlog.

### Environment namespaces

`TenantQueueOptions.namespaceSuffix` splices a segment inside the braces:
`orbitoz:{<tenantId>-staging}:queue`. Unused in a single-environment deployment;
it exists because a staging worker pointed at a production-shaped Redis would
otherwise consume production jobs. The integration harness passes a run id here
so concurrent runs cannot collide.

## Queues

| Queue                   | Processor                       | Work                            |
| ----------------------- | ------------------------------- | ------------------------------- |
| `ai-inference`          | `InferenceProcessor`            | Workflow / AI execution         |
| `usage-aggregation`     | `UsageAggregationProcessor`     | Usage rollup (module 06)        |
| `tenant-provisioning`   | `TenantProvisioningProcessor`   | Post-signup setup steps         |
| `notification-dispatch` | `NotificationDispatchProcessor` | Outbound webhook / notification |
| `dlq`                   | _operator, not a worker_        | Terminal failures               |

`WORKER_QUEUES` excludes `dlq`, and an integration test asserts that exclusion.
A DLQ entry consumed automatically would fail again and be dead-lettered a second
time — an infinite loop on one poison entry — and it would consume the retry budget
an operator replaying it is trying to reason about. There is no DLQ processor in
`queue-processors.ts`; the comment there says so, so the next person to add a
processor per queue finds the reasoning already written down.

The three non-inference processors log and complete. Their real work belongs to
later modules, and a job marked complete for a side effect that never happened is
worse than a job that fails and retries.

`InferenceProcessor` is the one processor that does real work today. It is a thin
translation onto `InferenceRunner` in `src/ai/`, which routes across providers,
fails over on a provider failure, parses structured output and persists the result
and its cost. The engine it drives is `@orbitoz/ai-engine`; see
[Module 04](../MODULE_04_AI_ORCHESTRATION.md) for that split and for why the
provider call deliberately runs between, not inside, the tenant transactions.

## The job envelope

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

`tenantId` and `traceId` are required; `userId` may be `null` because usage
rollups and tenant provisioning are not caused by a person. `validateJobContext`
reports **every** missing field at once — an operator reading a DLQ entry should
see the whole list, not fix one field per deploy.

`withJobContext` maps these onto the ambient scope the Prisma extension reads:
`traceId` becomes the scope's `requestId`, so a job's log lines join up with the
request that enqueued it. `userId: null` is omitted from the scope rather than
invented.

It is declared `async` deliberately. A non-async function that throws before its
first `await` throws _synchronously_, so a caller writing
`withJobContext(job, fn).catch(handle)` would get an uncaught exception that
escapes the worker's own try/catch.

Adding an envelope field means adding it **optional, forever**: a job enqueued
before a deploy must still process after it. The payload is untrusted input
restored from JSON in Redis and may be months old.

## Retries and the Dead Letter Queue

`DEFAULT_JOB_OPTIONS`: four attempts, exponential backoff from 1s, so retries at
1s, 2s and 4s — **±50% jitter**, because without it a provider blip that affects
a hundred tenants fails all hundred workflows on the same schedule and retries
them in lockstep. The documented schedule is therefore approximate.

A failure the policy calls terminal is rethrown as an `UnrecoverableError`, which
makes BullMQ move the job straight to the failed set with `attemptsMade: 1`
instead of burning three more attempts. A processor signals this by throwing an
error with `retryable: false`.

**Routing happens in the `failed` event, not in a `catch`.** BullMQ increments
`attemptsMade` _after_ the processor rejects, so a catch block sees the
pre-increment count: on the fourth and final attempt it reads 3 of 4, decides the
budget is not spent, and the job lands in the failed set with no DLQ entry at all.
The `failed` handler is the only place the terminal-attempt count is observable.
This was a real bug, caught by the integration suite rather than by inspection.

A DLQ entry carries the original envelope, the source queue, and the failure
detail — everything needed to replay it — and `DLQ_RETENTION_DAYS` / the job's
`removeOnFail: false` keep it until an operator acts. Replay is an explicit
`replayDeadLetter` call, never automatic: recovery is a deliberate act.

## Graceful shutdown

`SIGTERM` drains. `TenantWorker.onModuleDestroy` calls `worker.close()`, which
pauses first: an in-flight job finishes and a queued one stays in Redis for the
next process. Without the pause BullMQ marks the in-flight job stalled and hands
it to another worker while the original still executes — which is how one deploy
produces duplicate side effects.

- All workers drain **concurrently**. Sequential draining makes shutdown time the
  sum of every job's runtime.
- The drain is bounded by `DRAIN_TIMEOUT_MS` (25s). On timeout the worker is
  force-closed and remaining jobs are left for BullMQ's stalled-job checker; an
  operator can see that in the failed set, which beats a container that never
  exits and gets SIGKILLed.
- Order at exit: drain workers → close queues → disconnect database and Redis.
  Closing Redis while a worker still drains turns "the job finishes" into "the job
  fails on a closed connection".
- A **second** signal exits immediately. An operator sending `SIGTERM` twice means
  stop now.

## Redis connections

Two facts about the installed driver drive this:

- BullMQ needs `maxRetriesPerRequest: null` on any connection used for a blocking
  command. Left at ioredis's default, a worker fails at startup with a timeout
  that reads like a Redis outage — Redis is fine, and the worker's own blocking
  call exhausted the budget.
- **ioredis 6 has no per-client connection pool.** `maxConnections` is still
  accepted into `options` and silently ignored; one `Redis` instance is exactly
  one TCP connection. Verified against 6.0.0.

So there is no pool-size setting, and adding one would be a knob that reads like
a control and does nothing. `createQueueRedisConnection` carries a 10s command
timeout — generous for `LPUSH`/`SADD`, and short enough that a half-open socket
surfaces within a client request's own patience. It is the only factory, because
BullMQ strips `commandTimeout` from the client it duplicates for blocking, so the
same connection object is safe to hand to a `Worker`.

There is deliberately no separate blocking factory. A connection built with _no_
timeout and one whose timeout BullMQ removes before blocking are the same object
in practice; two factories would have implied a distinction the driver does not
make.

`REDIS_TLS=true` is required on any managed Redis that terminates TLS.

## Not a Nest application

A plain Node process. There is no HTTP surface, and `@nestjs/bullmq` would add a
container and a module graph to supervise a set of `Worker` instances. The Nest
symbols borrowed are `Logger` and `OnModuleDestroy` — the latter because
drain-on-shutdown is real lifecycle management that deserves an interface rather
than a hand-rolled `process.on` block.

Revisit this if the worker grows scheduled jobs or needs an admin endpoint. At
that point the container pays for itself.

## Tenant discovery

Tenants are not known until they exist, so the worker re-reads the `tenants` table
every `WORKER_TENANT_REFRESH_INTERVAL_MS` (30s) and subscribes any new ones. A
poll rather than a pub/sub: the database is the authority on which tenants exist,
so a worker that starts after a tenant was created has no notification to
receive. The cost is one indexed `SELECT id` per interval; the cost of getting it
wrong is a tenant's jobs sitting unconsumed until the next deploy.

## Testing

Two tiers, separated by how much of the system they need.

**Unit tests** (`pnpm test`, `src/**/*.test.ts`) — pure logic, no Redis, no
database. Runs anywhere, which is what keeps `pnpm verify` meaningful.

**Integration tests** (`pnpm test:integration`, `test/**/*.test.ts`) — real
BullMQ against a real Redis. These are the only tests that can prove the module's
central claim, which is about keyspaces: a mock has no keyspace to be wrong
about. Needs a live Redis on `TEST_REDIS_URL`, deliberately separate from
`REDIS_URL` because the suite deletes keys and must never be pointed at a shared
instance. Start one with `docker compose up -d redis`.

Every key carries a per-run id, so concurrent runs, stale keyspaces from aborted
runs, and a developer's own queues coexist. Cleanup `SCAN`s on that id and
`UNLINK`s in batches — never `KEYS`, which blocks the Redis event loop for the
length of the keyspace, and never a wildcard, which on a shared Redis would delete
someone else's queue.

The harness mirrors production wiring deliberately: producers and consumers resolve
their prefix from the same place, and processors run inside `withJobContext` for
job queues. Both were wrong in the first draft, and both failed silently rather
than loudly — a harness that diverges from production produces a green suite that
tests a worker nobody ships.

## Layout

```
src/
  main.ts                        entry point, tenant polling, signal handling
  config/env.ts                  Zod-validated configuration
  queues/
    connection.ts                ioredis factories
    tenant-queue.ts              prefix format, namespace guards, Queue registry
    dead-letter.ts               DLQ decision, routing, replay
  context/
    job-context.ts               envelope validation, AsyncLocalStorage bridge
  ai/
    credentials.ts               SecretStore / EnvSecretStore
    inference-store.ts           tenant-scoped persistence port + Prisma adapter
    inference-runner.ts          route -> failover -> parse -> persist
  worker/
    tenant-worker.ts             Worker supervision, drain, poison handling
    worker-database.ts           Prisma client, RLS assertion, tenant transactions
    inference.processor.ts       BullMQ job -> InferenceRunner
    queue-processors.ts
test/
  harness.ts                     isolated Redis/BullMQ fixtures
  *.integration.test.ts
```

## Scripts

| Command                 | Purpose                         |
| ----------------------- | ------------------------------- |
| `pnpm dev`              | Watch mode                      |
| `pnpm build`            | Compile to `dist/`              |
| `pnpm start`            | Run the compiled output         |
| `pnpm test`             | Unit tests (no Redis needed)    |
| `pnpm test:integration` | Integration tests (needs Redis) |
| `pnpm test:coverage`    | Unit tests with coverage        |

## ioredis 6 imports

```ts
import { Redis } from 'ioredis'; // not: import IORedis from 'ioredis'
```

The default export resolves to a namespace under NodeNext, which cannot be used
as a type. The named `Redis` export is both the value and the type.
