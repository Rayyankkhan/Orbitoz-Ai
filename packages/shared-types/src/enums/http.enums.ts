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

  // 409
  Conflict: 'CONFLICT',
  EmailAlreadyRegistered: 'EMAIL_ALREADY_REGISTERED',
  SlugAlreadyTaken: 'SLUG_ALREADY_TAKEN',

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

  [ErrorCode.Conflict]: 409,
  [ErrorCode.EmailAlreadyRegistered]: 409,
  [ErrorCode.SlugAlreadyTaken]: 409,

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
