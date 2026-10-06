/**
 * The authentication and authorization guard.
 *
 * Registered globally as `APP_GUARD`, so it runs on every route. A route opts out
 * with `@Public()`. The default is therefore *deny*: adding a controller without
 * thinking about auth produces an unreachable endpoint, which is a bug someone
 * notices, rather than an exposed one, which is a bug nobody notices.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HOST TENANT AND THE TOKEN TENANT MUST AGREE
 * ---------------------------------------------------------------------------
 * The tenant is resolved from the request `Host` by `TenantMiddleware`, before
 * this guard runs. The access token names its own tenant. If those two disagree,
 * one of three things is true:
 *
 *   * the client is pointed at the wrong subdomain for the session it holds —
 *     a stale tab after a tenant switch, which is a 409 the client can recover
 *     from by signing in again against the right host;
 *   * a token minted for tenant A is being replayed at tenant B, which is the
 *     attack this check exists to stop;
 *   * custom-domain DNS is mid-migration.
 *
 * All three are refused. The reason it is checked here and not only in the
 * handler is that RLS would happily accept the token's tenant if the transaction
 * were pinned to it — the database has no idea which host the HTTP request
 * arrived on. Binding host to token is purely an application-layer fact, so it
 * has to be an application-layer check.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROLE IN THE TOKEN IS TRUSTED HERE
 * ---------------------------------------------------------------------------
 * `memberships.role` is copied into the token, so this check reads a value that
 * could be up to `accessTtlSeconds` stale. Two things bound that: the TTL is
 * 15 minutes, and `GET /auth/me` re-reads the role from the database on every
 * call, so an operator demoting a member sees it take effect on the member's next
 * request rather than at token expiry.
 */
import { CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { TENANT_ROLE_RANK, type TenantRole } from '@orbitoz/shared-types';
import { TokenService, type VerifiedAccessToken } from './token.service.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY, ROLES_KEY, type AuthenticatedRequest } from './auth.decorators.js';
import {
  InsufficientRoleError,
  InvalidCredentialsError,
  TenantMismatchError,
  TokenExpiredError,
  UnauthenticatedError,
} from './auth.errors.js';
import { isActiveStatus, type Principal } from './auth.types.js';
import { resolvedTenantOf } from '../tenancy/request-locals.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthenticatedError('Missing Authorization: Bearer <accessToken> header.');
    }

    const verification = await this.tokens.verifyAccessToken(token);
    if (!verification.ok) {
      // The rejection reason is logged with the token's own tenant, which is
      // what makes "a valid token for tenant A was refused at tenant B"
      // diagnosable. The client is told only enough to know whether to refresh.
      const claimed = this.tokens.peekUnverified(token);
      this.logger.warn(
        `Rejected an access token (${verification.reason})` +
          `${claimed ? ` for tenant ${claimed.tenantId}` : ''} on ${request.method} ${request.url}`,
      );

      if (verification.reason === 'expired') throw new TokenExpiredError();
      throw new UnauthenticatedError('The access token is not valid.');
    }

    const claims = verification.claims;
    this.assertTenantMatches(claims, response);
    this.assertAccountUsable(claims);

    const principal: Principal = this.auth.toPrincipal(claims);
    request.auth = principal;

    this.assertRoleAllows(context, principal);

    return true;
  }

  /**
   * Refuses a token whose tenant differs from the request host's tenant.
   *
   * See the header for why all three explanations are treated the same way.
   */
  private assertTenantMatches(claims: VerifiedAccessToken, response: Response): void {
    // No resolved tenant means the route was reached without TenantMiddleware —
    // /health is the only such route and it is not guarded. Refusing is the safe
    // reading: a request we cannot attribute to a tenant has no business
    // carrying tenant-scoped credentials.
    const hostTenantId = resolvedTenantOf(response)?.tenantId;
    if (!hostTenantId) {
      throw new TenantMismatchError();
    }
    if (claims.tenantId !== hostTenantId) {
      this.logger.warn(
        `Access token for tenant ${claims.tenantId} presented to tenant ${hostTenantId}; refusing.`,
      );
      throw new TenantMismatchError();
    }
  }

  /**
   * Refuses a token whose account is suspended or deactivated.
   *
   * Read from the token rather than the database, because the account status is
   * frozen into the token at issue time and the signature already guarantees it
   * was `ACTIVE` then. A suspension issued afterwards is caught by the
   * `/auth/me` re-read; this catches the common case where the token was minted
   * while the account was already unusable.
   */
  private assertAccountUsable(claims: VerifiedAccessToken): void {
    if (!isActiveStatus(claims.userStatus)) {
      throw new InvalidCredentialsError();
    }
  }

  /**
   * Enforces `@Roles(...)`, using the rank table rather than string equality.
   *
   * A role satisfies a requirement when its rank is at least as high as the
   * lowest-ranked role listed, so `@Roles(OWNER, DEVELOPER)` is satisfied by
   * ADMIN and above without every caller restating the hierarchy. A role the
   * rank table does not know ranks lowest, so an unmapped role denies rather than
   * accidentally granting.
   */
  private assertRoleAllows(context: ExecutionContext, principal: Principal): void {
    const required = this.reflector.getAllAndOverride<readonly TenantRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return;

    const principalRank = TENANT_ROLE_RANK[principal.role] ?? 0;
    const permitted = required.some((role) => (TENANT_ROLE_RANK[role] ?? 0) <= principalRank);

    if (!permitted) {
      this.logger.warn(
        `User ${principal.userId} (${principal.role}) was refused ${required.join('/')}.`,
      );
      throw new InsufficientRoleError(required);
    }
  }

  /**
   * Pulls the token out of the `Authorization` header.
   *
   * The scheme is matched case-insensitively because RFC 7235 says the scheme is
   * case-insensitive and some clients send `bearer`. A malformed header returns
   * `null` rather than throwing, so the caller emits one consistent 401.
   */
  private extractBearerToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return null;

    const separator = header.indexOf(' ');
    if (separator <= 0) return null;

    const scheme = header.slice(0, separator);
    if (scheme.toLowerCase() !== 'bearer') return null;

    const token = header.slice(separator + 1).trim();
    return token.length > 0 ? token : null;
  }
}
