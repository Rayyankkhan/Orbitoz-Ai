/**
 * Cross-cutting enumerations.
 *
 * IMPORTANT: these are the *domain* enums. They are hand-written and
 * framework-agnostic. The Prisma enums in `@orbitoz/database/enums` are
 * generated from the DB schema and are re-exported separately. The
 * `enum-literal.test.ts` parity test keeps the two in lockstep.
 */

/** A user's role *within one tenant*. The same user may hold different roles
 *  in different tenants. Platform-level roles live on the User record. */
export const TenantRole = {
  Owner: 'OWNER',
  Admin: 'ADMIN',
  Developer: 'DEVELOPER',
  Analyst: 'ANALYST',
  Viewer: 'VIEWER',
  Billing: 'BILLING',
} as const;
export type TenantRole = (typeof TenantRole)[keyof typeof TenantRole];

export const TENANT_ROLE_RANK: Record<TenantRole, number> = {
  [TenantRole.Owner]: 100,
  [TenantRole.Admin]: 80,
  [TenantRole.Developer]: 60,
  [TenantRole.Analyst]: 40,
  [TenantRole.Billing]: 20,
  [TenantRole.Viewer]: 10,
};

/** Roles that may manage members, billing and tenant-level settings. */
export const TENANT_ADMIN_ROLES: readonly TenantRole[] = [TenantRole.Owner, TenantRole.Admin];

/** Roles permitted to create API keys and run inference jobs. */
export const TENANT_DEVELOPER_ROLES: readonly TenantRole[] = [
  TenantRole.Owner,
  TenantRole.Admin,
  TenantRole.Developer,
];

export const UserStatus = {
  Invited: 'INVITED',
  Active: 'ACTIVE',
  Suspended: 'SUSPENDED',
  Deactivated: 'DEACTIVATED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const TenantStatus = {
  Trialing: 'TRIALING',
  Active: 'ACTIVE',
  PastDue: 'PAST_DUE',
  Suspended: 'SUSPENDED',
  Canceled: 'CANCELED',
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

/** Only these tenants may issue API traffic. */
export const TENANT_SERVABLE_STATUSES: readonly TenantStatus[] = [
  TenantStatus.Trialing,
  TenantStatus.Active,
];

/**
 * Upstream AI provider identifiers.
 *
 * Not a Prisma enum — `provider_models.provider` is a `VarChar(64)`, so a new
 * provider needs no migration. That is deliberate: the catalogue is seeded data,
 * not a schema constraint, and a migration to add one would block a tenant's
 * self-hosted model until a release shipped.
 *
 * `LOCAL` was added because the seed catalogue already contained a self-hosted
 * `local` model that no enum member matched, making it unroutable: plan
 * entitlements list `allowedProviders`, a lookup of `'LOCAL'` missed every plan,
 * and the model was filtered out of every candidate list.
 */
export const AiProvider = {
  OpenAI: 'OPENAI',
  Anthropic: 'ANTHROPIC',
  Google: 'GOOGLE',
  Mistral: 'MISTRAL',
  Cohere: 'COHERE',
  AzureOpenAI: 'AZURE_OPENAI',
  Bedrock: 'BEDROCK',
  VertexAI: 'VERTEX_AI',
  /** Self-hosted, OpenAI-compatible (vLLM, llama.cpp, Ollama). Always tenant-specific. */
  Local: 'LOCAL',
} as const;
export type AiProvider = (typeof AiProvider)[keyof typeof AiProvider];

export type AiCapability =
  | 'CHAT'
  | 'COMPLETION'
  | 'EMBEDDING'
  | 'RERANK'
  | 'IMAGE'
  | 'AUDIO_TRANSCRIPTION'
  | 'MODERATION'
  | 'STRUCTURED_OUTPUT';

/** Lifecycle of a single routed request. Persisted on the Job row. */
export const JobStatus = {
  Queued: 'QUEUED',
  /**
   * Parked pending a human decision.
   *
   * Not terminal: an approved job moves on to `QUEUED`, and a rejected one to
   * `CANCELED`, so a job sitting here is still live. That matters because
   * `InferenceStore.startJob` refuses to restart a terminal job — if this were
   * terminal the resume path would be rejected by its own guard.
   *
   * No queue job exists in this state. The approval webhook creates it.
   */
  AwaitingApproval: 'AWAITING_APPROVAL',
  Running: 'RUNNING',
  Succeeded: 'SUCCEEDED',
  Failed: 'FAILED',
  Canceled: 'CANCELED',
  DeadLettered: 'DEAD_LETTERED',
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.Succeeded,
  JobStatus.Failed,
  JobStatus.Canceled,
  JobStatus.DeadLettered,
];

/**
 * Lifecycle of one human decision.
 *
 * `EXPIRED` is a decision nobody made. An approval request carries a deadline,
 * and past it the request stops being a live question — the job it gates is
 * canceled and any later click is refused. Recording that as a status rather
 * than leaving the row `PENDING` is what makes "why did this never run?"
 * answerable without a log search.
 */
export const ApprovalStatus = {
  Pending: 'PENDING',
  Approved: 'APPROVED',
  Rejected: 'REJECTED',
  Expired: 'EXPIRED',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

/** The only two things an approver may do. Absence of a third is deliberate. */
export const APPROVAL_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export function isApprovalAction(value: unknown): value is ApprovalAction {
  return typeof value === 'string' && (APPROVAL_ACTIONS as readonly string[]).includes(value);
}

/** A decision an approval request has already reached. */
export const TERMINAL_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  ApprovalStatus.Approved,
  ApprovalStatus.Rejected,
  ApprovalStatus.Expired,
];

/** How the router picked a provider for a request. */
export const RoutingStrategy = {
  /** Single provider pinned by the tenant; no failover. */
  Fixed: 'FIXED',
  /** Lowest cost that satisfies the capability + tenant allowlist. */
  CostOptimized: 'COST_OPTIMIZED',
  /** Highest measured quality for the tenant's tier. */
  QualityOptimized: 'QUALITY_OPTIMIZED',
  /** Minimise p95 latency, usually a small local model. */
  LatencyOptimized: 'LATENCY_OPTIMIZED',
  /** Round-robin across healthy providers, weighted by observed reliability. */
  Balanced: 'BALANCED',
  /** A model the tenant pinned, but failover allowed across aliases. */
  Failover: 'FAILOVER',
} as const;
export type RoutingStrategy = (typeof RoutingStrategy)[keyof typeof RoutingStrategy];

export const SubscriptionPlan = {
  Free: 'FREE',
  Starter: 'STARTER',
  Growth: 'GROWTH',
  Enterprise: 'ENTERPRISE',
} as const;
export type SubscriptionPlan = (typeof SubscriptionPlan)[keyof typeof SubscriptionPlan];

/** Plan entitlements, resolved server-side. Never trusted from the client. */
export const PLAN_ENTITLEMENTS: Record<SubscriptionPlan, PlanEntitlement> = {
  [SubscriptionPlan.Free]: {
    monthlyRequestQuota: 1_000,
    maxSeats: 3,
    maxApiKeys: 2,
    maxRpm: 10,
    maxConcurrentJobs: 2,
    allowedProviders: [AiProvider.OpenAI, AiProvider.Google, AiProvider.Local],
    allowedStrategies: [
      RoutingStrategy.CostOptimized,
      RoutingStrategy.LatencyOptimized,
      RoutingStrategy.Balanced,
    ],
    dataRetentionDays: 7,
  },
  [SubscriptionPlan.Starter]: {
    monthlyRequestQuota: 50_000,
    maxSeats: 10,
    maxApiKeys: 10,
    maxRpm: 60,
    maxConcurrentJobs: 10,
    allowedProviders: [
      AiProvider.OpenAI,
      AiProvider.Anthropic,
      AiProvider.Google,
      AiProvider.Local,
    ],
    allowedStrategies: [
      RoutingStrategy.CostOptimized,
      RoutingStrategy.LatencyOptimized,
      RoutingStrategy.Balanced,
    ],
    dataRetentionDays: 30,
  },
  [SubscriptionPlan.Growth]: {
    monthlyRequestQuota: 500_000,
    maxSeats: 50,
    maxApiKeys: 50,
    maxRpm: 300,
    maxConcurrentJobs: 50,
    allowedProviders: [
      AiProvider.OpenAI,
      AiProvider.Anthropic,
      AiProvider.Google,
      AiProvider.Mistral,
      AiProvider.Cohere,
      AiProvider.Local,
    ],
    allowedStrategies: [
      RoutingStrategy.CostOptimized,
      RoutingStrategy.QualityOptimized,
      RoutingStrategy.LatencyOptimized,
      RoutingStrategy.Balanced,
      RoutingStrategy.Failover,
    ],
    dataRetentionDays: 90,
  },
  [SubscriptionPlan.Enterprise]: {
    monthlyRequestQuota: Number.POSITIVE_INFINITY,
    maxSeats: Number.POSITIVE_INFINITY,
    maxApiKeys: Number.POSITIVE_INFINITY,
    maxRpm: Number.POSITIVE_INFINITY,
    maxConcurrentJobs: Number.POSITIVE_INFINITY,
    allowedProviders: Object.values(AiProvider),
    allowedStrategies: Object.values(RoutingStrategy),
    dataRetentionDays: 365,
  },
};

export interface PlanEntitlement {
  readonly monthlyRequestQuota: number;
  readonly maxSeats: number;
  readonly maxApiKeys: number;
  /** Requests per minute across all keys for a tenant. */
  readonly maxRpm: number;
  readonly maxConcurrentJobs: number;
  readonly allowedProviders: readonly AiProvider[];
  readonly allowedStrategies: readonly RoutingStrategy[];
  readonly dataRetentionDays: number;
}
