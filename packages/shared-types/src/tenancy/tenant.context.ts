import type { TenantId, UserId, MembershipId, RequestId } from '../core/branded.js';
import type { AiProvider, SubscriptionPlan, TenantRole, TenantStatus } from '../enums/index.js';

/**
 * How a tenant was identified on the current request.
 *
 * `SUBDOMAIN` is the production path (`acme.orbitoz.ai`).
 * `HEADER` exists for local dev, mobile and the first-request bootstrap call.
 * `JWT` is authoritative — see `isAuthoritative`.
 */
export const TenantResolutionSource = {
  Subdomain: 'SUBDOMAIN',
  Header: 'HEADER',
  CustomDomain: 'CUSTOM_DOMAIN',
  Jwt: 'JWT',
} as const;
export type TenantResolutionSource =
  (typeof TenantResolutionSource)[keyof typeof TenantResolutionSource];

/**
 * Resolved tenant, guaranteed present for any authenticated request.
 *
 * The invariant this type encodes: **no request handler ever receives a
 * tenantId from its own input.** It is resolved once, by `TenantResolver`, and
 * injected by `TenantContextInterceptor`. Anything a client sends is treated as
 * a hint, never as identity.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: SubscriptionPlan;
  readonly source: TenantResolutionSource;
  /** Host header the tenant was derived from — useful for audit logging. */
  readonly host: string;
  readonly resolvedAt: string;
}

/**
 * Authenticated principal. Attach to `request.user` via the JWT strategy.
 *
 * A user is global, but authority is always tenant-scoped: `memberships`
 * carries the role and `activeTenantId` is the tenant the token was issued
 * for. Every authorization check is `membership.role` against `activeTenantId`.
 */
export interface AuthenticatedUser {
  readonly userId: UserId;
  readonly email: string;
  readonly activeTenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly role: TenantRole;
  readonly isPlatformAdmin: boolean;
  readonly jti: string;
}

/** The full security principal, injected by `TenantContextInterceptor`. */
export interface RequestContext {
  readonly requestId: RequestId;
  readonly user: AuthenticatedUser | null;
  readonly tenant: TenantContext;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * @returns true when the source is cryptographically bound to the token and
 * therefore cannot be spoofed by a client header.
 */
export function isAuthoritative(source: TenantResolutionSource): boolean {
  return source === TenantResolutionSource.Jwt;
}

/** Order matters: the most trustworthy source that resolved wins. */
const SOURCE_RANK: Record<TenantResolutionSource, number> = {
  [TenantResolutionSource.Jwt]: 40,
  [TenantResolutionSource.CustomDomain]: 30,
  [TenantResolutionSource.Subdomain]: 20,
  [TenantResolutionSource.Header]: 10,
};

/**
 * Resolves conflicting tenant hints using trust ordering, and fails closed on
 * a genuine cross-tenant conflict.
 *
 * A legitimate mismatch is `Subdomain=acme` + `Header=acme` -> the same tenant.
 * An attack is `Subdomain=acme` + `Header=globex` -> throw, do not silently
 * prefer one.
 */
export function resolveConflict(
  candidates: readonly { source: TenantResolutionSource; tenantId: TenantId }[],
): TenantResolutionResult {
  if (candidates.length === 0) {
    throw new Error('TenantResolutionError: no tenant candidate was supplied');
  }

  const distinct = new Map<string, { source: TenantResolutionSource; tenantId: TenantId }>();
  for (const candidate of candidates) {
    const existing = distinct.get(candidate.tenantId);
    if (!existing || SOURCE_RANK[candidate.source] > SOURCE_RANK[existing.source]) {
      distinct.set(candidate.tenantId, candidate);
    }
  }

  if (distinct.size > 1) {
    throw new Error(
      `TenantResolutionError: conflicting tenant hints -> ${[...distinct.keys()].join(', ')}`,
    );
  }

  // `distinct.size === 1` holds here, but destructuring still types the result
  // as possibly-undefined, and asserting it away would defeat the check.
  const [winner] = distinct.values();
  if (winner === undefined) {
    throw new Error('TenantResolutionError: no tenant candidate was supplied');
  }
  return { tenantId: winner.tenantId, source: winner.source };
}

/** Extracts the subdomain label from a host header. */
export function extractSubdomain(host: string | undefined, rootDomain: string): string | null {
  if (!host) return null;

  // Strip the port, then normalise case and any trailing dot (FQDN root).
  const hostname = host.split(':')[0]?.toLowerCase().replace(/\.$/, '');
  if (!hostname) return null;

  const root = rootDomain.toLowerCase();
  if (hostname === root || hostname === `www.${root}`) return null;
  if (!hostname.endsWith(`.${root}`)) return null;

  const label = hostname.slice(0, -(root.length + 1));
  // Reject multi-level subdomains such as `a.b.orbitoz.ai`.
  if (!label || label.includes('.')) return null;
  return label;
}

/**
 * The result of resolving a Host header to a tenant.
 *
 * Identity only — no authority. Roles live in `memberships` and are attached
 * later by the auth layer, so nothing downstream can mistake "we know which
 * tenant this is" for "this caller may act on it".
 */
export interface ResolvedTenant {
  readonly tenantId: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: SubscriptionPlan;
  /** Non-null means the tenant is suspended and requests must be refused. */
  readonly suspendedAt: string | null;
}

/** Widens a resolved tenant into the full request context. */
export function toTenantContext(
  resolved: ResolvedTenant,
  source: TenantResolutionSource,
  host: string,
): TenantContext {
  return {
    tenantId: resolved.tenantId,
    slug: resolved.slug,
    name: resolved.name,
    status: resolved.status,
    plan: resolved.plan,
    source,
    host,
    resolvedAt: new Date().toISOString(),
  };
}

export interface TenantResolutionResult {
  readonly tenantId: TenantId;
  readonly source: TenantResolutionSource;
}

/** Providers a tenant has explicitly enabled. Empty means "plan default". */
export interface TenantProviderEntitlement {
  readonly provider: AiProvider;
  readonly enabled: boolean;
  /** Model ids the tenant may target; empty means all the provider exposes. */
  readonly allowedModels: readonly string[];
  /** Optional per-tenant key reference into the secrets manager — never a raw key. */
  readonly credentialRef: string | null;
}
