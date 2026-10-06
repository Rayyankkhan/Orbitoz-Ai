/**
 * Worker entry point.
 *
 * A plain process rather than a Nest application: there is no HTTP surface, and
 * `@nestjs/bullmq` would add a container and a module graph to supervise a set of
 * `Worker` instances. The only Nest symbols borrowed are `Logger`,
 * `OnModuleDestroy` and `createApplicationContext`-free DI — shutdown is real
 * lifecycle management and deserves an interface rather than a signal handler
 * block, but a full container is not warranted.
 *
 * ---------------------------------------------------------------------------
 * SHUTDOWN IS THE PART THAT MATTERS
 * ---------------------------------------------------------------------------
 * `SIGTERM` drains: `TenantWorker.onModuleDestroy` pauses each worker, so a job
 * already running finishes and a job still queued stays in Redis for the next
 * process. Without the pause, BullMQ marks the in-flight job stalled and hands it
 * to another worker while the original is still executing — which is how one
 * deploy produces duplicate side effects.
 *
 * A second signal exits immediately. An operator sending `SIGTERM` twice means
 * stop now, and waiting out a 25s drain would make that impossible.
 */
import { Logger } from '@nestjs/common';
import { loadEnv } from './config/env.js';
import { QUEUE_NAMES, WORKER_QUEUES } from '@orbitoz/shared-types';
import { TenantQueueRegistry } from './queues/tenant-queue.js';
import { createQueueRedisConnection } from './queues/connection.js';
import { WorkerDatabase } from './worker/worker-database.js';
import { InferenceProcessor, inferenceShouldRetry } from './worker/inference.processor.js';
import { EnvSecretStore } from './ai/credentials.js';
import { PrismaInferenceStore } from './ai/inference-store.js';
import { InferenceRunner } from './ai/inference-runner.js';
import {
  NotificationDispatchProcessor,
  TenantProvisioningProcessor,
  UsageAggregationProcessor,
} from './worker/queue-processors.js';
import { TenantWorker, DRAIN_TIMEOUT_MS, type TenantJobProcessor } from './worker/tenant-worker.js';

const logger = new Logger('Worker');

async function main(): Promise<void> {
  const env = loadEnv();

  // Producer-side connection. BullMQ's blocking clients are created per Worker
  // inside `TenantWorker.subscribe`; this one serves the registry and the DLQ
  // router, and carries a command timeout because neither blocks.
  const connection = createQueueRedisConnection(env.redis.url, {
    commandTimeoutMs: env.redis.commandTimeoutMs,
  });
  const registry = new TenantQueueRegistry({ connection });
  const db = new WorkerDatabase(env.database.url);

  // Fails startup when the role bypasses RLS, rather than letting every job
  // quietly read nothing.
  await db.assertRlsEnforced();

  // The runner holds the two seams the engine must not know about: where
  // credentials come from, and where the job is persisted. Both are injected so
  // the provider/client layer stays free of tenancy and Prisma.
  const runner = new InferenceRunner({
    store: new PrismaInferenceStore(db),
    secrets: new EnvSecretStore(process.env),
    shouldRetry: inferenceShouldRetry,
  });
  const inference = new InferenceProcessor(runner);
  const usage = new UsageAggregationProcessor();
  const provisioning = new TenantProvisioningProcessor();
  const notification = new NotificationDispatchProcessor();

  // Widened to `unknown`: `TenantWorker` is generic-free by design, and a
  // processor's payload type is checked where it is *defined* rather than at
  // every wiring site. Each processor narrows `job.data.payload` itself, which is
  // the same trust boundary the envelope validation draws.
  const processors: Record<(typeof WORKER_QUEUES)[number], TenantJobProcessor<unknown>> = {
    [QUEUE_NAMES.AiInference]: inference.process as TenantJobProcessor<unknown>,
    [QUEUE_NAMES.UsageAggregation]: usage.process as TenantJobProcessor<unknown>,
    [QUEUE_NAMES.TenantProvisioning]: provisioning.process as TenantJobProcessor<unknown>,
    [QUEUE_NAMES.NotificationDispatch]: notification.process as TenantJobProcessor<unknown>,
  };

  const workers = WORKER_QUEUES.map(
    (queue) =>
      new TenantWorker(
        {
          queue,
          connection,
          registry,
          concurrency: env.worker.concurrency,
          maxTenants: env.worker.maxTenants,
          rateLimit: { max: env.worker.rateLimitMax, duration: env.worker.rateLimitDurationMs },
        },
        processors[queue],
      ),
  );

  logger.log(
    `Worker ready: concurrency=${env.worker.concurrency} ` +
      `queues=${WORKER_QUEUES.join(',')} maxTenants=${env.worker.maxTenants} perQueue`,
  );

  // Tenants are not known until they exist. Subscribing at boot would need a scan
  // of every namespace in Redis; instead the set is refreshed on the interval
  // below and new tenants are picked up within one tick. See
  // docs/MODULE_03_BULLMQ_WORKER.md for why this is a poll and not a pub/sub.
  await subscribeKnownTenants(workers, db, env.worker.tenantRefreshIntervalMs);

  const shutdown = createShutdown({ workers, registry, connection, db });
  installSignalHandlers(shutdown, DRAIN_TIMEOUT_MS + 5_000);
}

/**
 * Subscribes a worker to every tenant that already has rows in the database.
 *
 * Bounded by the database rather than by Redis: the `tenants` table is the
 * authority on which tenants exist, so a Redis key left behind by a deleted
 * tenant does not resurrect a worker for it. The reverse — a tenant created while
 * the process is down — is picked up on the next tick.
 */
async function subscribeKnownTenants(
  workers: readonly TenantWorker[],
  db: WorkerDatabase,
  intervalMs: number,
): Promise<void> {
  const refresh = async (): Promise<void> => {
    const tenants = await db.unscoped(
      async (client) => client.tenant.findMany({ select: { id: true } }),
      'worker tenant discovery (the tenants table is global; no tenant is known yet)',
    );

    for (const worker of workers) {
      for (const { id } of tenants) {
        try {
          worker.subscribe(id);
        } catch (error) {
          // A worker at its tenant cap is a scaling signal, not a crash. Log once
          // per tick and let the next deploy with a higher cap pick it up.
          logger.warn(
            `Could not subscribe ${worker.constructor.name} to tenant ${id}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  };

  await refresh();
  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  // Unref'd so the refresh timer cannot hold the process open during shutdown.
  timer.unref?.();
}

/** Everything that has to be released before the process exits. */
interface ShutdownResources {
  readonly workers: readonly TenantWorker[];
  readonly registry: TenantQueueRegistry;
  readonly connection: { quit(): Promise<unknown> };
  readonly db: WorkerDatabase;
}

/**
 * Drains workers, then closes queues, then Redis.
 *
 * In that order, and each step waits for the previous: closing Redis while a
 * worker is still draining turns "the job finishes" into "the job fails on a
 * closed connection". The database goes last because a job that is mid-transaction
 * needs it.
 *
 * Idempotent, so a signal arriving during an explicit shutdown is harmless.
 */
function createShutdown(resources: ShutdownResources): () => Promise<void> {
  let started = false;

  return async (): Promise<void> => {
    if (started) return;
    started = true;

    logger.log('Draining workers');
    await Promise.all(resources.workers.map((worker) => worker.onModuleDestroy()));

    logger.log('Closing queues');
    await resources.registry.closeAll();

    logger.log('Disconnecting database and Redis');
    await Promise.allSettled([resources.db.disconnect(), resources.connection.quit()]);

    logger.log('Shutdown complete');
  };
}

/**
 * Wires signal handling.
 *
 * `hardExitAfterMs` is a backstop: a drain that hangs must not hold a deploy
 * open forever. On the second signal the process exits immediately — an operator
 * asking twice means stop now.
 */
function installSignalHandlers(shutdown: () => Promise<void>, hardExitAfterMs: number): void {
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals) => (): void => {
    // A second signal exits at once, whatever the drain is doing. An operator who
    // sends SIGTERM twice means stop now, and making them wait out a drain to do
    // it would be the wrong answer.
    if (shuttingDown) {
      logger.warn(`${signal} received again; exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;

    logger.log(`${signal} received; draining`);
    void shutdown().then(() => process.exit(0));

    const timer = setTimeout(() => {
      logger.error(`${signal} drain did not finish in ${hardExitAfterMs}ms; exiting anyway`);
      process.exit(1);
    }, hardExitAfterMs);
    timer.unref?.();
  };

  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error(
    `Worker failed to start: ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});
