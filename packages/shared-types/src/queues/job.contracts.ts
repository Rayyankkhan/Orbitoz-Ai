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
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Envelope prepended to every job. Carries tenancy across the process gap. */
export interface BaseJob<TPayload = unknown> {
  readonly id: JobId;
  readonly tenantId: TenantId;
  readonly actorId: UserId | null;
  readonly requestId: RequestId;
  readonly enqueuedAt: string;
  /** Bumped by the producer on retry so consumers can dedupe. */
  readonly attempt: number;
  readonly payload: TPayload;
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
 * Default job options. Chosen so a provider 5xx does not burn the whole
 * worker concurrency pool: 4 attempts over ~30s, then dead-letter.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
} as const;

/** BullMQ job names, exported for the gateway's queue producers. */
export const QUEUE_JOB_NAMES = {
  [QUEUE_NAMES.UsageAggregation]: 'usage.aggregate',
  [QUEUE_NAMES.TenantProvisioning]: 'tenant.provision',
  [QUEUE_NAMES.NotificationDispatch]: 'notification.dispatch',
} as const;
