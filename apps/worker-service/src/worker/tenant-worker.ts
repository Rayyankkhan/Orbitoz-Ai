/**
 * A Nest worker: one BullMQ Worker per tenant queue, with tenant scope
 * established per job and exhausted failures routed to the tenant's DLQ.
 *
 * The unit of work is `(tenantId, queueName)`. Each pair gets its own Worker
 * because BullMQ discovers work by blocking on that pair's keys — which is what
 * makes cross-tenant isolation a property of the keyspace rather than something
 * a processor has to remember to check.
 *
 * NOT a Nest application. There is no HTTP surface here, and `@nestjs/bullmq`
 * would add a container and a module graph to supervise a set of `Worker`
 * instances. The only Nest symbols borrowed are `Logger` and `OnModuleDestroy` —
 * the latter because drain-on-shutdown is real lifecycle management that
 * deserves an interface, not a hand-rolled `process.on` block.
 *
 * Cost note, since per-tenant workers multiply everything: each Worker holds two
 * connections (one blocking, one for commands). A worker serving T tenants on one
 * queue-type holds 2T. `TENANT_WORKER_MAX` bounds that, and past it a worker
 * refuses new tenants rather than quietly opening connections until Redis refuses
 * them — see {@link TenantWorker}.
 */
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { UnrecoverableError, Worker, type Job, type JobsOptions, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import type { BaseJob, QueueName, WorkerQueueName } from '@orbitoz/shared-types';
import { queuePrefixFor, type TenantQueueRegistry } from '../queues/tenant-queue.js';
import { DeadLetterRouter } from '../queues/dead-letter.js';
import { isRetryable, withJobContext, type JobContext } from '../context/job-context.js';

const logger = new Logger('TenantWorker');

/** A handler for one kind of job, run inside the job's tenant scope. */
export type TenantJobProcessor<T = unknown> = (
  context: JobContext,
  job: Job<BaseJob<T>>,
) => Promise<void>;

export interface TenantWorkerConfig {
  /** Which queue-type this worker consumes. */
  readonly queue: WorkerQueueName;
  readonly concurrency: number;
  /** Max rate across all of this worker's tenants. */
  readonly rateLimit?: { readonly max: number; readonly duration: number };
  /** Safety valve on the blocking connections one worker may open. */
  readonly maxTenants: number;
  /** Injected by tests; production builds these from the env. */
  readonly connection: Redis;
  readonly registry: TenantQueueRegistry;
}

export class TenantWorkerLimitError extends Error {
  constructor(
    readonly queue: WorkerQueueName,
    readonly maxTenants: number,
  ) {
    super(
      `Refusing to subscribe ${queue} to another tenant: this worker already serves ${maxTenants}. ` +
        'Each tenant costs two blocking connections. Scale out horizontally instead of raising this.',
    );
    this.name = 'TenantWorkerLimitError';
  }
}

/**
 * Supervises the BullMQ Workers for one queue-type across many tenants.
 *
 * Implements `OnModuleDestroy` so Nest's shutdown hook drains it, which is what
 * stops a deploy from failing every in-flight job.
 */
export class TenantWorker implements OnModuleDestroy {
  private readonly workers = new Map<string, Worker>();
  private readonly dlq: DeadLetterRouter;
  private closed = false;

  constructor(
    private readonly config: TenantWorkerConfig,
    private readonly processor: TenantJobProcessor,
  ) {
    this.dlq = new DeadLetterRouter(config.registry);
  }

  /**
   * Starts consuming one tenant's queue.
   *
   * Idempotent per tenant: calling twice returns the existing worker rather than
   * opening a second blocking connection to the same keys.
   *
   * @throws {TenantWorkerLimitError} when the tenant cap is reached.
   */
  subscribe(tenantId: string): Worker {
    const existing = this.workers.get(tenantId);
    if (existing) return existing;

    if (this.workers.size >= this.config.maxTenants) {
      throw new TenantWorkerLimitError(this.config.queue, this.config.maxTenants);
    }

    const worker = new Worker<BaseJob<unknown>>(this.config.queue, (job) => this.handle(job), {
      connection: this.config.connection,
      prefix: queuePrefixFor(tenantId),
      concurrency: this.config.concurrency,
      // Pausing on SIGTERM is BullMQ's default and is what makes drain
      // safe: an in-flight job finishes, a queued one stays queued for the next
      // process rather than being marked failed.
      ...(this.config.rateLimit ? { limiter: this.config.rateLimit } : {}),
    });

    worker.on('error', (error) => {
      logger.error(
        `Worker for tenant ${tenantId} on ${this.config.queue} errored: ${error.message}`,
      );
    });

    // DLQ routing lives here, not in `handle`'s catch. BullMQ increments
    // `attemptsMade` *after* the processor rejects, so a catch block sees the
    // pre-increment count: on the fourth and final attempt it reads 3 of 4, the
    // budget-exhausted branch never fires, and the job lands in BullMQ's failed
    // set with no DLQ entry. The `failed` event fires after the increment, which
    // is the only place the terminal-attempt count is observable.
    worker.on('failed', (job, error) => {
      if (job === undefined) return;
      void this.routeFailure(job, error);
    });

    this.workers.set(tenantId, worker);
    logger.log(
      `Subscribed ${this.config.queue} for tenant ${tenantId} ` +
        `(prefix=${queuePrefixFor(tenantId)}, concurrency=${this.config.concurrency})`,
    );

    return worker;
  }

  /**
   * Runs one job inside its tenant scope.
   *
   * Rethrows so BullMQ applies its own retry bookkeeping. A failure the policy
   * says is terminal is rethrown as an {@link UnrecoverableError}, which is how a
   * poison job skips the remaining attempts: BullMQ moves it straight to the
   * failed set with `attemptsMade: 1`, rather than burning three more attempts
   * and delaying the operator's signal by the length of the backoff schedule.
   */
  private async handle(job: Job<BaseJob<unknown>>): Promise<void> {
    const tenantId = typeof job.data?.tenantId === 'string' ? job.data.tenantId : 'unknown';
    try {
      await withJobContext(job, (context) => this.processor(context, job));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Job ${job.id} (${job.name}) for tenant ${tenantId} failed on attempt ` +
          `${job.attemptsMade + 1}/${job.opts.attempts ?? '?'}: ${message}`,
      );

      if (isRetryable(error)) throw error;

      // `UnrecoverableError` takes only a message in BullMQ 6, so the original is
      // attached by hand. `cause` is preserved because BullMQ stores whatever is
      // thrown as the job's `failedReason`, and "model not available on this plan"
      // is more useful in the failed set than a wrapper's generic text.
      const unrecoverable = new UnrecoverableError(message) as Error & {
        cause?: unknown;
        retryable?: boolean;
      };
      unrecoverable.cause = error;
      // Carries the policy decision through to the `failed` handler, so the DLQ
      // entry records `NON_RETRYABLE` rather than the generic `EXHAUSTED`. Without
      // it the reason would be a lie: the budget was not exhausted, it was skipped.
      unrecoverable.retryable = false;
      throw unrecoverable;
    }
  }

  /**
   * Files a failed job on its tenant's DLQ when the policy says it is terminal.
   *
   * Errors are logged rather than thrown: this runs in an event handler, and an
   * unhandled rejection there would take the process down over a DLQ write that
   * failed — losing the worker that could have retried the routing.
   */
  private async routeFailure(job: Job<BaseJob<unknown>>, error: Error): Promise<void> {
    try {
      const routed = await this.dlq.route(job, error);
      if (routed === null) return;

      const tenantId = typeof job.data?.tenantId === 'string' ? job.data.tenantId : 'unknown';
      logger.warn(`Job ${job.id} dead-lettered as ${routed} for tenant ${tenantId}`);
    } catch (routeError) {
      logger.error(
        `Failed to dead-letter job ${job.id}: ` +
          `${routeError instanceof Error ? routeError.message : String(routeError)}. ` +
          'It remains in the BullMQ failed set and can be requeued manually.',
      );
    }
  }

  /** Tenants this worker is currently serving. */
  get tenants(): readonly string[] {
    return [...this.workers.keys()];
  }

  /**
   * Drains: stops accepting new jobs and waits for in-flight ones to finish.
   *
   * `worker.close()` pauses the worker first, so a job that has not started stays
   * in Redis and the next process picks it up. Without that pause the job is
   * marked stalled and retried elsewhere while the original is still running —
   * which is how one deploy produces duplicate side effects.
   *
   * All workers drain concurrently rather than in sequence: sequential draining
   * makes shutdown time the *sum* of every job's runtime, and a deploy with a
   * 10-minute timeout cannot afford that.
   *
   * Bounded so a wedged job cannot hang the deploy forever. On timeout the
   * worker is force-closed and the remaining jobs are left stalled for BullMQ's
   * stalled-job checker to recover — an operator can see that in the failed set,
   * which beats a container that never exits and gets SIGKILLed.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const open = [...this.workers.entries()];
    this.workers.clear();
    if (open.length === 0) return;

    logger.log(`Draining ${open.length} worker(s); in-flight jobs will finish`);

    const drains = open.map(async ([tenantId, worker]) => {
      try {
        await withTimeout(worker.close(), DRAIN_TIMEOUT_MS, `${this.config.queue}/${tenantId}`);
      } catch (error) {
        logger.error(
          `Drain failed for ${this.config.queue}/${tenantId}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            'Remaining jobs are stalled and will be recovered by BullMQ.',
        );
        // `close(force)` rejects in-flight jobs so the connection is released.
        await worker.close(true).catch(() => undefined);
      }
    });

    await Promise.all(drains);
    logger.log('Drain complete');
  }
}

/** How long a deploy waits for in-flight jobs before forcing them. */
export const DRAIN_TIMEOUT_MS = 25_000;

/** Rejects with a named error if `promise` has not settled in `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms draining ${label}`));
    }, ms);
    // Unref'd so a pending drain timer cannot hold the event loop open and stop
    // the process from exiting on its own.
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type { JobsOptions, Processor, QueueName };
