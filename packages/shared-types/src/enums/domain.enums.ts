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

/** Upstream AI provider identifiers. Extend by adding to the Prisma enum. */
export const AiProvider = {
  OpenAI: 'OPENAI',
  Anthropic: 'ANTHROPIC',
  Google: 'GOOGLE',
  Mistral: 'MISTRAL',
  Cohere: 'COHERE',
  AzureOpenAI: 'AZURE_OPENAI',
  Bedrock: 'BEDROCK',
  VertexAI: 'VERTEX_AI',
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
    allowedProviders: [AiProvider.OpenAI, AiProvider.Google],
    allowedStrategies: [RoutingStrategy.CostOptimized, RoutingStrategy.LatencyOptimized],
    dataRetentionDays: 7,
  },
  [SubscriptionPlan.Starter]: {
    monthlyRequestQuota: 50_000,
    maxSeats: 10,
    maxApiKeys: 10,
    maxRpm: 60,
    maxConcurrentJobs: 10,
    allowedProviders: [AiProvider.OpenAI, AiProvider.Anthropic, AiProvider.Google],
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
