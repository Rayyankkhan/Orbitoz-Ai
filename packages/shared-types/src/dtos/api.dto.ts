import type { ApiKeyId, RequestId, TenantId, UserId } from '../core/branded.js';
import type {
  AiProvider,
  ApprovalAction,
  ApprovalStatus,
  JobStatus,
  RoutingStrategy,
  SubscriptionPlan,
  TenantRole,
  UserStatus,
} from '../enums/index.js';

/* ========================================================================== */
/* Auth                                                                       */
/* ========================================================================== */

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
  /** Optional tenant slug for users who belong to several tenants. */
  readonly tenantSlug?: string;
}

export interface RegisterTenantRequest {
  readonly organizationName: string;
  readonly slug: string;
  readonly adminName: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
}

export interface RefreshTokenRequest {
  readonly refreshToken: string;
}

export interface AuthTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

export interface AuthSession extends AuthTokenPair {
  readonly user: SessionUser;
  readonly tenant: SessionTenant;
}

export interface SessionUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string | null;
  readonly status: UserStatus;
  readonly isPlatformAdmin: boolean;
  readonly avatarUrl: string | null;
}

export interface SessionTenant {
  readonly id: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly plan: SubscriptionPlan;
  readonly role: TenantRole;
  readonly memberships: readonly TenantMembershipSummary[];
}

export interface TenantMembershipSummary {
  readonly tenantId: TenantId;
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly role: TenantRole;
}

/* ========================================================================== */
/* Generic envelope                                                           */
/* ========================================================================== */

export interface ApiSuccess<T> {
  readonly data: T;
  readonly meta: ApiMeta;
}

export interface ApiFailure {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly { readonly path: string; readonly message: string }[];
  };
  readonly meta: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ApiMeta {
  readonly requestId: string;
  readonly timestamp: string;
}

/* ========================================================================== */
/* Pagination                                                                 */
/* ========================================================================== */

/** Cursor pagination. Opaque cursor, stable ordering — no drifting offsets. */
export interface PageParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly pageInfo: PageInfo;
}

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly totalCount: number | null;
}

export interface PageRequest extends PageParams {
  readonly sortBy?: string;
  readonly sortDirection?: 'asc' | 'desc';
  readonly search?: string;
}

/* ========================================================================== */
/* API keys                                                                  */
/* ========================================================================== */

export interface CreateApiKeyRequest {
  readonly name: string;
  readonly expiresAt?: string;
  /** Scopes the key to a subset of capabilities. */
  readonly scopes?: readonly string[];
}

export interface ApiKeyCreated {
  readonly id: ApiKeyId;
  readonly name: string;
  /** Returned exactly once, at creation. Never retrievable afterwards. */
  readonly secret: string;
  readonly prefix: string;
  readonly createdAt: string;
}

export interface ApiKeySummary {
  readonly id: ApiKeyId;
  readonly name: string;
  readonly prefix: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/* ========================================================================== */
/* AI routing / inference                                                     */
/* ========================================================================== */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface InferenceOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  /** Ask the provider for a JSON object matching this shape. */
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateInferenceRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly capability?: string;
  readonly provider?: AiProvider;
  readonly strategy?: RoutingStrategy;
  readonly options?: InferenceOptions;
  /** Fan out to N providers and return all responses (comparison mode). */
  readonly n?: number;
  readonly stream?: boolean;
}

export interface InferenceJobAccepted {
  readonly jobId: string;
  readonly status: 'QUEUED' | 'RUNNING';
  readonly requestId: string;
  readonly estimatedCostUsd: number | null;
  readonly pollUrl: string;
}

export interface UsageSummary {
  readonly tenantId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalRequests: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly byProvider: readonly ProviderUsage[];
  readonly byModel: readonly ModelUsage[];
}

export interface ProviderUsage {
  readonly provider: AiProvider;
  readonly requests: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly errorRate: number;
}

export interface ModelUsage {
  readonly model: string;
  readonly provider: AiProvider;
  readonly requests: number;
  readonly tokens: number;
  readonly costUsd: number;
}

/* ========================================================================== */
/* Health                                                                     */
/* ========================================================================== */

export interface HealthReport {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly uptimeSeconds: number;
  readonly version: string;
  readonly checks: Readonly<Record<string, HealthCheckResult>>;
}

export interface HealthCheckResult {
  readonly status: 'up' | 'down';
  readonly latencyMs?: number;
  readonly message?: string;
}

/* ========================================================================== */
/* Human-in-the-loop approvals                                                 */
/* ========================================================================== */

/**
 * What the approver is being asked to authorise.
 *
 * The row is created before anyone is asked, so the approval view is rendered
 * from durable state rather than from a link the sender could have embellished.
 * `model` and `maxCostUsd` are the two fields a person actually decides on, so
 * they are lifted out of the queue payload instead of being buried in it.
 */
export interface ApprovalSummary {
  readonly approvalId: string;
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly status: ApprovalStatus;
  readonly model: string;
  readonly strategy: RoutingStrategy;
  readonly maxCostUsd: number | null;
  readonly requestedBy: UserId;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  /** True once an approved request's queue job is confirmed enqueued. */
  readonly dispatched: boolean;
}

/** The `GET /approvals/:token` response: everything needed to render a page. */
export interface ApprovalView {
  readonly approval: ApprovalSummary;
  /** What a click on each button must POST. Pre-signed, so the page needs no JS. */
  readonly actions: {
    readonly approve: ApprovalActionGrant;
    readonly reject: ApprovalActionGrant;
  };
}

/**
 * A pre-signed authorisation for one action on one approval.
 *
 * `timestamp` and `signature` are what the webhook re-verifies. They travel in
 * the page rather than in a header because the approver is a person in a
 * browser: there is no client-side secret to compute a fresh signature with, so
 * the signature is issued once, for one action, with a bounded lifetime.
 */
export interface ApprovalActionGrant {
  readonly action: ApprovalAction;
  readonly timestamp: string;
  readonly signature: string;
}

/** The `POST /approvals/:token` request body. */
export interface DecideApprovalRequest {
  readonly action: ApprovalAction;
  readonly timestamp: string;
  readonly signature: string;
  readonly note?: string;
}

/**
 * The `POST /approvals/:token` response.
 *
 * `outcome` distinguishes a decision this call recorded from one that was
 * already there. A repeated click gets 200 with `already_decided`, never a
 * conflict: a webhook sender that retries after a lost response must not be told
 * it did something wrong when in fact the work is running.
 */
export interface ApprovalDecisionResult {
  readonly approval: ApprovalSummary;
  readonly outcome: 'recorded' | 'already_decided';
  readonly jobStatus: JobStatus;
  /** True when this call enqueued the job. False on a replay. */
  readonly dispatched: boolean;
  readonly requestId: RequestId;
}

/** The response to creating an approval request. */
export interface ApprovalRequestCreated {
  readonly approvalId: string;
  readonly jobId: string;
  readonly token: string;
  readonly status: ApprovalStatus;
  readonly expiresAt: string;
  /**
   * The tenant-scoped URL the approver opens.
   *
   * Relative rather than absolute on purpose: the gateway does not know its own
   * public origin, and an absolute URL assembled from an untrusted `Host` header
   * is a redirect primitive pointed at a phishing site.
   */
  readonly approvalPath: string;
  readonly viewPath: string;
  readonly requestId: RequestId;
}

/* ========================================================================== */
/* Audit                                                                      */
/* ========================================================================== */

export interface AuditEvent<TPayload = Readonly<Record<string, unknown>>> {
  readonly requestId: RequestId;
  readonly tenantId: TenantId;
  readonly actorId: UserId | null;
  readonly action: string;
  readonly target: string;
  readonly ip: string | null;
  readonly payload: TPayload;
  readonly occurredAt: string;
}
