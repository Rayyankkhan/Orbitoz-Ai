# `apps/worker-service`

BullMQ consumer for inference jobs.

## Not a Nest application

A plain Node process. There is no HTTP surface, and `@nestjs/bullmq` would add a
container and a module graph to supervise a single `Worker` instance. The only
Nest symbol borrowed is `Logger`.

Revisit this if the worker grows scheduled jobs or needs an admin endpoint — at
that point the container pays for itself.

## Tenancy across the process gap

A worker has no request to inherit a tenant scope from, so it establishes one per
job, from the job envelope:

```ts
const { tenantId, id, payload } = job.data;

await prisma.$transaction(async (tx) => {
  await setRlsTenant(tx, tenantId);
  const record = await tx.inferenceJob.findUnique({
    where: { tenantId_id: { tenantId, id } },
  });
  // ...
});
```

This is the single largest source of cross-tenant bugs in worker code: a job for
tenant A silently reading or writing tenant B's rows. Tenancy comes from
`job.data.tenantId` and nowhere else.

Treat every field of the payload as untrusted. It is restored from JSON in Redis
and may be months old.

## The job contract

Queue names, payload shapes, and retry policy come from
`@orbitoz/shared-types/queues` — the same declarations the gateway produces
with. A locally-defined copy would let a rename ship a producer the workers
cannot parse, and the failure mode is a worker idling on a queue nobody writes to.

```ts
import { DEFAULT_JOB_OPTIONS, INFERENCE_JOB, QUEUE_NAMES } from '@orbitoz/shared-types';
```

Adding a field means adding it **optional, forever**: a job enqueued before a
deploy must still process after it.

## Redis

BullMQ requires `maxRetriesPerRequest: null` on its connection. A worker blocks
on commands; a finite retry count makes Redis answer with an error during a
brief blip, which surfaces as a spurious job failure. Use a separate connection
for anything that wants retries.

`REDIS_TLS=true` is required on any managed Redis that terminates TLS.

## Graceful shutdown

`SIGTERM` and `SIGINT` call `worker.close()`, which lets in-flight jobs finish
instead of failing on every deploy. `startWorker` also logs unhandled errors and
failed jobs through the Nest logger.

## Layout

```
src/
  main.ts                    entry point, signal handling
  worker.ts                  BullMQ Worker wiring
  config/env.ts              Zod-validated configuration
  queues/
    connection.ts            ioredis factory (maxRetriesPerRequest: null)
    inference.queue.ts       re-exports the shared contract
  processors/
    inference.processor.ts   the job handler
```

## Scripts

| Command      | Purpose                          |
| ------------ | -------------------------------- |
| `pnpm dev`   | Watch mode                       |
| `pnpm build` | Typecheck and compile to `dist/` |
| `pnpm start` | Run the compiled output          |

## ioredis 6 imports

```ts
import { Redis } from 'ioredis'; // not: import IORedis from 'ioredis'
```

The default export resolves to a namespace under NodeNext, which cannot be used
as a type. The named `Redis` export is both the value and the type.
