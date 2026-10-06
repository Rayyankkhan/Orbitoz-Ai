/** Canonical API error codes. Clients switch on these, never on prose. */
export const ErrorCode = {
  // 400
  ValidationFailed: 'VALIDATION_FAILED',
  MalformedRequest: 'MALFORMED_REQUEST',
  UnsupportedCapability: 'UNSUPPORTED_CAPABILITY',

  // 401 / 403
  Unauthenticated: 'UNAUTHENTICATED',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  TokenExpired: 'TOKEN_EXPIRED',
  TokenRevoked: 'TOKEN_REVOKED',
  Forbidden: 'FORBIDDEN',
  InsufficientRole: 'INSUFFICIENT_ROLE',

  // 404
  NotFound: 'NOT_FOUND',
  TenantNotFound: 'TENANT_NOT_FOUND',
  /**
   * No approval request matches the presented token *for this tenant*.
   *
   * Deliberately one code for unknown-token, another-tenant's-token and
   * already-purged-token. Distinguishing them would turn the endpoint into an
   * oracle for testing whether a token exists somewhere in the system, which is
   * the one thing a 256-bit capability URL must not be.
   */
  ApprovalNotFound: 'APPROVAL_NOT_FOUND',

  // 401/403 on the approval webhook. The endpoint is public — the approver is a
  // person following a link, not a principal holding an access token — so these
  // are the webhook's own authentication failures rather than session problems.
  ApprovalSignatureInvalid: 'APPROVAL_SIGNATURE_INVALID',
  ApprovalSignatureExpired: 'APPROVAL_SIGNATURE_EXPIRED',

  // 410
  /**
   * The approval link was real and has since passed its deadline.
   *
   * A 410 rather than a 404 because the distinction is actionable and honest:
   * the token *was* valid, so the approver learns that their link went stale
   * rather than being told it never existed, which would send them to whoever
   * sent it to ask for a new one.
   */
  ApprovalExpired: 'APPROVAL_EXPIRED',

  // 409
  Conflict: 'CONFLICT',
  EmailAlreadyRegistered: 'EMAIL_ALREADY_REGISTERED',
  SlugAlreadyTaken: 'SLUG_ALREADY_TAKEN',
  // The session's tenant and the request host's tenant disagree. A distinct code
  // from FORBIDDEN because the client's recovery differs: re-resolve the tenant
  // and sign in again, rather than treat it as a permission problem and retry.
  TenantMismatch: 'TENANT_MISMATCH',

  // 402 / 403 billing
  PaymentRequired: 'PAYMENT_REQUIRED',
  QuotaExceeded: 'QUOTA_EXCEEDED',
  TenantSuspended: 'TENANT_SUSPENDED',
  FeatureNotInPlan: 'FEATURE_NOT_IN_PLAN',

  // 429
  RateLimited: 'RATE_LIMITED',

  // 5xx
  InternalError: 'INTERNAL_ERROR',
  UpstreamUnavailable: 'UPSTREAM_UNAVAILABLE',
  UpstreamTimeout: 'UPSTREAM_TIMEOUT',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const HTTP_STATUS_BY_ERROR_CODE: Record<ErrorCode, number> = {
  [ErrorCode.ValidationFailed]: 400,
  [ErrorCode.MalformedRequest]: 400,
  [ErrorCode.UnsupportedCapability]: 400,

  [ErrorCode.Unauthenticated]: 401,
  [ErrorCode.InvalidCredentials]: 401,
  [ErrorCode.TokenExpired]: 401,
  [ErrorCode.TokenRevoked]: 401,

  [ErrorCode.Forbidden]: 403,
  [ErrorCode.InsufficientRole]: 403,
  [ErrorCode.TenantSuspended]: 403,
  [ErrorCode.FeatureNotInPlan]: 403,

  [ErrorCode.NotFound]: 404,
  [ErrorCode.TenantNotFound]: 404,
  [ErrorCode.ApprovalNotFound]: 404,

  [ErrorCode.ApprovalSignatureInvalid]: 401,
  [ErrorCode.ApprovalSignatureExpired]: 401,

  [ErrorCode.ApprovalExpired]: 410,

  [ErrorCode.Conflict]: 409,
  [ErrorCode.EmailAlreadyRegistered]: 409,
  [ErrorCode.SlugAlreadyTaken]: 409,
  [ErrorCode.TenantMismatch]: 409,

  [ErrorCode.PaymentRequired]: 402,
  [ErrorCode.QuotaExceeded]: 429,
  [ErrorCode.RateLimited]: 429,

  [ErrorCode.InternalError]: 500,
  [ErrorCode.UpstreamUnavailable]: 502,
  [ErrorCode.UpstreamTimeout]: 504,
  [ErrorCode.ServiceUnavailable]: 503,
};

export const ApiVersion = {
  V1: 'v1',
} as const;
export type ApiVersion = (typeof ApiVersion)[keyof typeof ApiVersion];

/** Named rate-limit buckets, keyed to BullMQ queue names. */
export const RateLimitScope = {
  Auth: 'auth',
  Inference: 'inference',
  General: 'general',
} as const;
export type RateLimitScope = (typeof RateLimitScope)[keyof typeof RateLimitScope];

/** Seconds. Access tokens are short-lived; refresh tokens are rotated. */
export const TOKEN_TTL = {
  Access: 900,
  Refresh: 1_209_600,
} as const;
