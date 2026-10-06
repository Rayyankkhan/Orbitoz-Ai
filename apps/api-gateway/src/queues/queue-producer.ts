/**
 * The gateway's side of the queue: a producer for approved jobs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATEWAY HAS A REDIS DEPENDENCY AT ALL
 * ---------------------------------------------------------------------------
 * `job.contracts.ts` has always described the gateway as the *producer*; this
 * is that end of it. Until now nothing in the gateway enqueued anything, because
 * every job it created was created and consumed without leaving the request. A
 * human-in-the-loop gate breaks that: the job row is written during a request
 * that finishes immediately, and the queue entry has to appear minutes or hours
 * later, in a different request, triggered by a click.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE AND NOT A BullMQ `@Module`
 * ---------------------------------------------------------------------------
 * The gateway is a Nest application, so the obvious shape is `@nestjs/bullmq`.
 * It is deliberately not used: that module's value is a container-managed
 * `Worker` per queue, and a gateway consumes nothing. What is needed here is one
 * long-lived `Redis` and a lazily-created `Queue` per tenant, with a shutdown
 * hook — which is what the worker service already hand-rolls for exactly the same
 * reason (see `apps/worker-service/src/main.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUEUE HANDLE IS CACHED PER TENANT
 * ---------------------------------------------------------------------------
 * A BullMQ `Queue` holds a Redis connection, and creating one per enqueue would
 * exhaust the pool within minutes of traffic. The cache is keyed by tenant so a
 * tenant has exactly one producer connection per queue type. `createQueueRedisConnection`
 * caps command latency, which is the right failure mode here: an enqueue that
 * hangs on a half-open socket holds an HTTP request open, whereas an error lets
 * the webhook tell its caller what happened.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  tenantQueuePrefix,
  type BaseJob,
  type QueueName,
} from '@orbitoz/shared-types';
import { EnvService } from '../config/env.service.js';

export interface EnqueueOptions {
  readonly queue: QueueName;
  /** The queue's job name, e.g. `inference.route`. See `INFERENCE_JOB`. */
  readonly jobName: string;
  /**
   * The BullMQ job id.
   *
   * Must be deterministic for anything that could be enqueued twice: BullMQ
   * silently ignores an `add` whose `jobId` already exists, which is what makes
   * a retried dispatch safe without a distributed lock.
   */
  readonly jobId: string;
  readonly envelope: BaseJob;
  readonly options?: JobsOptions;
}

/**
 * Enqueues a job onto one tenant's namespaced queue.
 *
 * The prefix comes from {@link tenantQueuePrefix} in shared-types — the same
 * function the worker uses to subscribe — rather than from a copy of the format.
 * If the two ever disagreed, a producer would write to one Redis keyspace and a
 * consumer would poll another, and every approval would silently resume nothing.
 */
@Injectable()
export class QueueProducer implements OnModuleDestroy {
  private readonly logger = new Logger(QueueProducer.name);
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();

  constructor(env: EnvService) {
    this.connection = new Redis(env.value.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      commandTimeout: env.value.redis.commandTimeoutMs,
    });
    // An enqueue that fails because Redis is down must fail loudly on this
    // process, not be swallowed by ioredis' default reconnect-forever loop: the
    // decision has already been committed, so the caller needs to know the
    // resume did not happen.
    this.connection.on('error', (error: Error) => {
      this.logger.error(`Redis connection error while enqueueing: ${error.message}`);
    });
  }

  /**
   * Adds a job, keyed by `tenantId`/queue.
   *
   * @returns true when a job was created, false when BullMQ deduplicated it
   *   because that `jobId` already exists. The caller records which happened, so
   *   "the resume was a no-op" is visible in the audit trail rather than inferred.
   */
  async enqueue(input: EnqueueOptions): Promise<boolean> {
    const queue = this.queueFor(input.envelope.tenantId, input.queue);
    const existing = await queue.getJob(input.jobId);
    if (existing !== undefined) {
      this.logger.log(`Job ${input.jobId} already present on ${input.queue}; not enqueueing again`);
      return false;
    }

    await queue.add(input.jobName, input.envelope, {
      jobId: input.jobId,
      ...(input.options ?? DEFAULT_JOB_OPTIONS),
    });
    return true;
  }

  /** The queue for one tenant, created on first use. */
  private queueFor(tenantId: string, queueName: QueueName): Queue {
    const key = `${tenantId} ${queueName}`;
    const existing = this.queues.get(key);
    if (existing) return existing;

    const created = new Queue(queueName, {
      connection: this.connection,
      prefix: tenantQueuePrefix(tenantId),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    this.queues.set(key, created);
    return created;
  }

  /** How many queue handles are open. Used by tests. */
  get openQueueCount(): number {
    return this.queues.size;
  }

  /**
   * Closes every queue, then the connection.
   *
   * Queues first: closing Redis while a queue is still open turns "the job is
   * enqueued" into "the connection dropped mid-LPUSH" during a deploy.
   */
  async onModuleDestroy(): Promise<void> {
    const open = [...this.queues.values()];
    this.queues.clear();
    await Promise.allSettled(open.map((queue) => queue.close()));
    await Promise.allSettled([this.connection.quit()]);
  }
}

/**
 * The queue an approved inference job runs on.
 *
 * Named rather than inlined at the call site so the coupling between an approval
 * and the queue that serves it is one line anyone can find.
 */
export const APPROVAL_RESUME_QUEUE = QUEUE_NAMES.AiInference;
