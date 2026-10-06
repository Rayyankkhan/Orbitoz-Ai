import type { TenantId, UserId, JobId, RequestId } from '../core/branded.js';
import type { AiProvider, JobStatus, RoutingStrategy } from '../enums/index.js';

/**
 * The contract between `apps/api-gateway` (producer) and
 * `apps/worker-service` (consumer).
 *
 * Both apps import these types from `@orbitoz/shared-types/queues`, so a
 * breaking change here is a compile error in both services simultaneously —
 * you cannot ship a producer that the workers cannot parse.
 *
 * Two hard rules for this file:
 *  1. Treat every field as untrusted input on the consumer side. The payload
 *     is restored from JSON in Redis and may be months old.
 *  2. Add fields as optional, forever. Queues are long-lived: a job enqueued
 *     before a deploy must still process after it.
 */

export const QUEUE_NAMES = {
  AiInference: 'ai-inference',
  UsageAggregation: 'usage-aggregation',
  TenantProvisioning: 'tenant-provisioning',
  NotificationDispatch: 'notification-dispatch',
  /**
   * The dead letter queue, one per tenant like every other queue.
   *
   * A job lands here after exhausting its retry budget. It is namespaced by
   * tenant exactly like a working queue, so a poison job can never occupy or
   * block another tenant's backlog, and an operator replaying a DLQ is replaying
   * one tenant's failures.
   */
  DeadLetter: 'dlq',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * The queues a worker consumes, and the ones it produces.
 *
 * `DeadLetter` is deliberately absent from {@link WORKER_QUEUES}: the DLQ is
 * written to by the failed-job handler and drained by an operator or a replay
 * command, not consumed by a processor.
 */
export const WORKER_QUEUES = [
  QUEUE_NAMES.AiInference,
  QUEUE_NAMES.UsageAggregation,
  QUEUE_NAMES.TenantProvisioning,
  QUEUE_NAMES.NotificationDispatch,
] as const satisfies readonly QueueName[];
export type WorkerQueueName = (typeof WORKER_QUEUES)[number];

/**
 * Per-tenant Redis key prefix for a queue.
 *
 * BullMQ builds every key for a queue as `<prefix>:<queueName>:<type>`, and it
 * **throws** if the queue name itself contains a colon. So the tenant namespace
 * has to be the `prefix` option, not part of the name — which is what produces
 * the documented `orbitoz:{tenantId}:queue:{queueName}` shape.
 *
 * The braces are literal, not Redis Cluster hash tags. They exist to make the
 * namespace greppable in `redis-cli --scan` and to make it obvious that
 * `{tenantId}` is a substitution point rather than a fixed segment.
 *
 * Consequences worth knowing:
 *  - Two tenants' jobs live in physically distinct keyspaces, so a worker
 *    subscribed to tenant A cannot observe tenant B's backlog at all.
 *  - `tenantId` is a UUID validated before it reaches this function; it cannot
 *    contain a colon or a brace and forge a different namespace.
 */
export function tenantQueuePrefix(tenantId: string): string {
  return `orbitoz:{${tenantId}}:queue`;
}

/** The fully-qualified key prefix for one tenant's copy of one queue. */
export function tenantQueueKey(tenantId: string, queueName: QueueName): string {
  return `${tenantQueuePrefix(tenantId)}:${queueName}`;
}

/** The Dead Letter Queue name for a tenant. Reads better than a raw constant. */
export function deadLetterQueueName(_tenantId: string): QueueName {
  return QUEUE_NAMES.DeadLetter;
}

/**
 * Envelope prepended to every job. Carries tenancy across the process gap.
 *
 * `tenantId`, `userId` and `traceId` are the three fields a consumer cannot
 * process a job without, and all three are required rather than optional: a job
 * that reaches a worker with no tenant id has no safe interpretation, and the
 * correct response is to fail it loudly rather than guess.
 *
 * `userId` is `null` for system-initiated work (usage rollups, tenant
 * provisioning) where no human triggered the job. `traceId` correlates the job
 * back to the request that caused it, across the process boundary.
 */
export interface BaseJob<TPayload = unknown> {
  readonly id: JobId;
  readonly tenantId: TenantId;
  /** Null only for system-initiated jobs with no human actor. */
  readonly userId: UserId | null;
  /** Correlates this job with the inbound request that produced it. */
  readonly traceId: RequestId;
  readonly enqueuedAt: string;
  /** Bumped by the producer on retry so consumers can dedupe. */
  readonly attempt: number;
  readonly payload: TPayload;
}

/**
 * Validates that a restored payload carries the required context fields.
 *
 * Payloads come back from Redis as untyped JSON: nothing enforces the shape but
 * this check. A job enqueued before this field existed, or by a producer that
 * skipped validation, must fail here rather than reaching a processor that would
 * then read `tenantId` as `undefined` and query the wrong tenant's rows.
 *
 * @returns the narrowed envelope, or a list of human-readable problems.
 */
export function validateJobContext(data: unknown):
  | {
      readonly ok: true;
      readonly context: BaseJob;
    }
  | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];

  if (typeof data !== 'object' || data === null) {
    return { ok: false, problems: ['payload is not an object'] };
  }
  const candidate = data as Partial<Record<keyof BaseJob, unknown>>;

  if (typeof candidate.tenantId !== 'string' || candidate.tenantId.length === 0) {
    problems.push('tenantId must be a non-empty string');
  }
  if (candidate.userId !== null && typeof candidate.userId !== 'string') {
    problems.push('userId must be a string or null');
  }
  if (typeof candidate.traceId !== 'string' || candidate.traceId.length === 0) {
    problems.push('traceId must be a non-empty string');
  }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    problems.push('id must be a non-empty string');
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    context: {
      id: candidate.id as JobId,
      tenantId: candidate.tenantId as TenantId,
      userId: candidate.userId as UserId | null,
      traceId: candidate.traceId as RequestId,
      enqueuedAt: typeof candidate.enqueuedAt === 'string' ? candidate.enqueuedAt : '',
      attempt: typeof candidate.attempt === 'number' ? candidate.attempt : 0,
      payload: candidate.payload,
    },
  };
}

/* ========================================================================== */
/* ai-inference                                                              */
/* ========================================================================== */

export interface InferenceJobPayload {
  readonly model: string;
  readonly provider: AiProvider | null;
  readonly strategy: RoutingStrategy;
  readonly messages: readonly InferenceMessage[];
  readonly options: {
    readonly temperature: number | null;
    readonly maxTokens: number | null;
    readonly topP: number | null;
    readonly stopSequences: readonly string[] | null;
    readonly responseSchema: Readonly<Record<string, unknown>> | null;
  };
  /** Fan-out mode: how many candidate providers to call in parallel. */
  readonly fanout: number;
  readonly idempotencyKey: string | null;
  readonly maxCostUsd: number | null;
}

export interface InferenceMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name: string | null;
  readonly toolCallId: string | null;
}

export interface ProviderAttemptResult {
  readonly provider: AiProvider;
  readonly model: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly error: SerializedError | null;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly retryable: boolean;
}

export interface InferenceResult {
  readonly jobId: JobId;
  readonly tenantId: TenantId;
  readonly status: JobStatus;
  readonly chosenProvider: AiProvider | null;
  readonly model: string;
  readonly content: string | null;
  readonly finishReason: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly attempts: readonly ProviderAttemptResult[];
  readonly error: SerializedError | null;
}

/** Job names on the `ai-inference` queue. */
export const INFERENCE_JOB = {
  Route: 'inference.route',
  Cancel: 'inference.cancel',
} as const;
export type InferenceJobName = (typeof INFERENCE_JOB)[keyof typeof INFERENCE_JOB];

/* ========================================================================== */
/* usage-aggregation                                                          */
/* ========================================================================== */

export interface UsageAggregationJob {
  readonly tenantId: TenantId;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/* ========================================================================== */
/* tenant-provisioning                                                       */
/* ========================================================================== */

export interface TenantProvisioningJob {
  readonly tenantId: TenantId;
  readonly slug: string;
  readonly steps: readonly ProvisioningStep[];
}

export const PROVISIONING_STEPS = [
  'CREATE_DEFAULT_ROLES',
  'SEED_PROVIDER_CATALOG',
  'CREATE_BILLING_CUSTOMER',
  'WARM_ENTITLEMENT_CACHE',
] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];

/* ========================================================================== */
/* Defaults                                                                   */
/* ========================================================================== */

/**
 * Default job options: **3 retries with a 1s exponential backoff**.
 *
 * BullMQ's `attempts` counts *total* tries, not retries, so `attempts: 4` is one
 * initial attempt plus 3 retries. The delays are `base * 2^(n-1)`:
 *
 *   try 1 → immediately
 *   try 2 → 1s
 *   try 3 → 2s
 *   try 4 → 4s   ← still fails, job is routed to the tenant's DLQ
 *
 * 1s rather than the 2s this used to carry: the fastest useful signal that a
 * provider is genuinely down is its first error, and a 7s total window fits
 * inside a single webhook timeout while still spanning the short blips worth
 * retrying. Transient provider 5xx and connection resets clear long before the
 * budget runs out; a job still failing at try 4 is not going to clear.
 *
 * `jitter` thins out the thundering herd when a Redis or provider blip stalls
 * many jobs at once — without it every job retries on exactly the same
 * millisecond and re-creates the overload that caused the failure.
 *
 * Retention: completed jobs are trimmed after an hour (enough to debug a recent
 * run, not enough to grow unbounded), failures after a week, because a failure
 * is the thing someone will want to inspect.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
} as const;

/**
 * Options for a job that has been routed to the Dead Letter Queue.
 *
 * `attempts: 1` is the point of the DLQ: a job that already exhausted its budget
 * must not consume another full retry cycle when it lands here, and a replay
 * operator working through the backlog does not want 50 dead jobs retrying in
 * parallel while they examine them.
 *
 * `removeOnFail: false` keeps a job that fails again on manual replay — the
 * operator needs to see it, not have it vanish.
 */
export const DEAD_LETTER_JOB_OPTIONS = {
  attempts: 1,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: false,
  removeOnFail: false,
} as const;

/** BullMQ job names, exported for the gateway's queue producers. */
export const QUEUE_JOB_NAMES = {
  [QUEUE_NAMES.UsageAggregation]: 'usage.aggregate',
  [QUEUE_NAMES.TenantProvisioning]: 'tenant.provision',
  [QUEUE_NAMES.NotificationDispatch]: 'notification.dispatch',
} as const;

/* ========================================================================== */
/* Dead letter queue                                                          */
/* ========================================================================== */

/**
 * Why a job was routed to the DLQ.
 *
 * `Exhausted` is the ordinary case: the retry budget ran out.
 * `NonRetryable` means the job failed with an error that could never succeed on
 * a retry — a validation failure, a missing provider model, a payload that no
 * longer parses — and it skips the retry budget entirely rather than burning four
 * attempts to reach the same conclusion.
 * `Abandoned` is a worker shutting down with a job in flight that could not be
 * completed; it is replayed rather than dead-lettered by default.
 */
export const DLQ_REASON = {
  Exhausted: 'EXHAUSTED',
  NonRetryable: 'NON_RETRYABLE',
  Abandoned: 'ABANDONED',
} as const;
export type DlqReason = (typeof DLQ_REASON)[keyof typeof DLQ_REASON];

/** The DLQ job name, distinct from the source queue's job name. */
export const DLQ_JOB = {
  /** A job that exhausted its retry budget. */
  Dead: 'dlq.dead',
  /** A job replayed back onto its original queue by an operator. */
  Replay: 'dlq.replay',
} as const;
export type DlqJobName = (typeof DLQ_JOB)[keyof typeof DLQ_JOB];

/** Error shape preserved when a failure crosses into the DLQ. */
export interface DeadLetterFailure {
  readonly name: string;
  readonly message: string;
  /** How many times the job was attempted before it was dead-lettered. */
  readonly attempts: number;
  readonly failedAt: string;
  /** Whether a replay might plausibly succeed. */
  readonly retryable: boolean;
}

/**
 * What is enqueued onto a tenant's DLQ.
 *
 * Carries the original job in full, not just its id: the source queue may have
 * already trimmed it, and an operator replaying needs the payload to be able to
 * put the job back exactly as it was.
 */
export interface DeadLetterJobPayload {
  /** The queue the job came from. Replay targets this. */
  readonly sourceQueue: QueueName;
  readonly sourceJobName: string;
  readonly sourceJobId: string;
  readonly reason: DlqReason;
  readonly failure: DeadLetterFailure;
  /** The original envelope, including its tenant context. */
  readonly original: BaseJob;
}
