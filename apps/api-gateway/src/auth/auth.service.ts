/**
 * Auth service — registration, sign-in, refresh and sign-out.
 *
 * ---------------------------------------------------------------------------
 * THE TENANT PROBLEM, AND WHY IT SHAPES EVERY METHOD HERE
 * ---------------------------------------------------------------------------
 * Two of these operations cannot run inside a tenant-scoped transaction, and the
 * reason is structural rather than incidental.
 *
 * SIGN-IN looks a user up by email. `users` is a GLOBAL model with no
 * `tenant_id` column — a person is not owned by a tenant, they hold
 * `memberships`. Scoping that lookup to the request's tenant would be wrong: the
 * account exists before, and independently of, any membership. It runs through
 * `PrismaService.unscoped()`, which logs the bypass at warn level so the set of
 * unscoped reads stays greppable in production.
 *
 * The membership check afterwards is the opposite case and the security-critical
 * one: it *is* tenant-scoped, so RLS enforces it. A valid account on tenant A
 * presenting credentials to tenant B's subdomain fails here — not because the
 * code compared two ids, but because the database refuses to return the row.
 * See `docs/architecture/multi-tenancy.md`.
 *
 * REGISTRATION is subtler still. `rls_tenants_insert` is keyed on
 * `app_tenant_unset()`, so a tenant row may only be created while no tenant is
 * in scope. The provisioning transaction therefore pins `app.tenant_id` to the
 * brand-new tenant id immediately after the insert, and every subsequent write
 * in that transaction is an ordinary tenant-scoped write.
 *
 * ---------------------------------------------------------------------------
 * WHY `unscoped()` CALLS PASS EXPLICIT tenantId
 * ---------------------------------------------------------------------------
 * `PrismaService.unscoped()` hands back the raw client, which does *not* carry
 * the tenant-injection extension. The compensating control is that every
 * tenant-scoped write inside those transactions names its `tenantId`
 * explicitly. A missing one is a NOT NULL violation — a loud failure — rather
 * than a silent row with no tenant, which is the outcome worth fearing.
 *
 * ---------------------------------------------------------------------------
 * WHY REFRESH IS ROTATING
 * ---------------------------------------------------------------------------
 * A refresh token that is not rotated is a 14-day bearer credential that leaks
 * quietly on a shared machine. Each use revokes the presented token and issues a
 * replacement in the same `family_id`, so exactly one token per session is live.
 * Replaying a superseded token means two clients hold one family — the signature
 * of a stolen token — so the whole family is revoked and every session on it must
 * sign in again. That is a deliberate availability trade: taking the attacker and
 * the victim offline together beats leaving the attacker in.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  PLAN_ENTITLEMENTS,
  TENANT_SERVABLE_STATUSES,
  TenantRole,
  asTenantId,
  asUserId,
  type AuthSession,
  type SessionTenant,
  type SessionUser,
  type SubscriptionPlan,
  type TenantStatus,
  type UserStatus,
} from '@orbitoz/shared-types';
import { PrismaService, setRlsTenant } from '@orbitoz/database';
import { TenantTransaction } from '../tenancy/tenant-transaction.js';
import { EnvService } from '../config/env.service.js';
import { TokenService, hashRefreshToken, type VerifiedAccessToken } from './token.service.js';
import {
  checkPasswordPolicy,
  canSignIn,
  isPlausibleEmail,
  isValidTenantSlug,
  normalizeEmail,
  type AuthSessionView,
  type Principal,
  type RequestFingerprint,
  type SessionUserRow,
} from './auth.types.js';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  SlugAlreadyTakenError,
  TenantMismatchError,
  TenantNotServableError,
  TokenExpiredError,
  TokenRevokedError,
  WeakPasswordError,
} from './auth.errors.js';
import { hashPassword, inspectPasswordHash, verifyPassword } from './password.js';

/** Why a refresh token family was revoked. Recorded on every affected row. */
const REVOKE_REASON = {
  Rotated: 'ROTATED',
  Replay: 'REPLAY_DETECTED',
  SignOut: 'SIGNOUT',
  Expired: 'EXPIRED',
} as const;

const TRIAL_LENGTH_MS = 14 * 24 * 60 * 60 * 1_000;

export interface RegisterTenantInput {
  readonly organizationName: string;
  readonly slug: string;
  readonly adminName: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly fingerprint: RequestFingerprint;
  readonly requestId: string;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly fingerprint: RequestFingerprint;
  readonly requestId: string;
}

/** The tenant resolved from the request host by `TenantMiddleware`. */
export interface RequestTenant {
  readonly tenantId: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly plan: SubscriptionPlan;
  readonly suspendedAt: string | null;
}

/** Tokens plus their expiry, as returned by {@link AuthService.issueTokens}. */
interface IssuedTokens {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TenantTransaction,
    private readonly tokens: TokenService,
    private readonly env: EnvService,
  ) {}

  /**
   * Creates a tenant, its owner, an OWNER membership and a FREE subscription.
   *
   * The only operation in the system that mints a tenant. Runs on the raw client
   * because there is no tenant to scope to until this transaction has created
   * one; `rls_tenants_insert` permits exactly that, and only that.
   */
  async registerTenant(input: RegisterTenantInput): Promise<AuthSession> {
    const email = normalizeEmail(input.adminEmail);
    const slug = input.slug.toLowerCase();

    if (!isPlausibleEmail(email) || !isValidTenantSlug(slug)) {
      // Both report the same error. Distinguishing "malformed email" from
      // "malformed slug" is harmless, but collapsing an invalid *email* into a
      // credentials error is not — it keeps the endpoint from becoming a
      // validation oracle that reveals which addresses are real.
      if (!isPlausibleEmail(email)) throw new InvalidCredentialsError();
      throw new SlugAlreadyTakenError();
    }

    const passwordProblems = checkPasswordPolicy(input.adminPassword);
    if (passwordProblems.length > 0) {
      throw new WeakPasswordError(passwordProblems.map((problem) => problem.message));
    }

    // Hashed before the transaction opens. scrypt is deliberately slow, and
    // holding a database transaction open for 70ms of pure CPU would occupy a
    // pooled connection for the whole of it.
    const passwordHash = await hashPassword(input.adminPassword, this.env.scryptCost);
    const refresh = this.tokens.issueRefreshToken();

    const created = await this.prisma.unscoped(
      (client) =>
        client.$transaction(async (tx) => {
          const [existingUser, existingTenant] = await Promise.all([
            tx.user.findUnique({ where: { email }, select: { id: true } }),
            tx.tenant.findUnique({ where: { slug }, select: { id: true } }),
          ]);
          if (existingUser) throw new EmailAlreadyRegisteredError();
          if (existingTenant) throw new SlugAlreadyTakenError();

          const tenant = await tx.tenant.create({
            data: {
              slug,
              name: input.organizationName.trim(),
              status: 'TRIALING',
              plan: 'FREE',
              // Mirrors PLAN_ENTITLEMENTS.FREE so the denormalised columns on
              // `tenants` agree with the plan. The Subscription row stays
              // authoritative; both are written in this one transaction.
              monthlyRequestQuota: PLAN_ENTITLEMENTS.FREE.monthlyRequestQuota,
              maxSeats: PLAN_ENTITLEMENTS.FREE.maxSeats,
              maxRpm: PLAN_ENTITLEMENTS.FREE.maxRpm,
              trialEndsAt: new Date(Date.now() + TRIAL_LENGTH_MS),
            },
            select: { id: true, slug: true, name: true, plan: true },
          });

          // From here the transaction is tenant-scoped like any other. `SET
          // LOCAL` means the setting cannot outlive the transaction, so the
          // pooled connection is clean for whoever borrows it next.
          await setRlsTenant(tx, tenant.id);

          const user = await tx.user.create({
            data: {
              email,
              name: input.adminName.trim() || null,
              passwordHash,
              // No confirmation mail is sent yet, but the creator typed their own
              // address into their own tenant, so it is as verified as it gets.
              // Flip this when a mail service lands.
              emailVerifiedAt: new Date(),
              status: 'ACTIVE',
            },
            select: USER_SELECT,
          });

          // `memberships` is tenant-scoped, so the RLS policy is satisfied by
          // `tenant.id` matching the pinned scope. tenantId is named explicitly
          // because this is the raw client, which does not inject it.
          await tx.membership.create({
            data: { tenantId: tenant.id, userId: user.id, role: TenantRole.Owner },
          });

          await tx.subscription.create({
            data: {
              tenantId: tenant.id,
              plan: 'FREE',
              status: 'TRIALING',
              seats: 1,
              currentPeriodStart: new Date(),
              currentPeriodEnd: new Date(Date.now() + TRIAL_LENGTH_MS),
            },
          });

          await tx.refreshToken.create({
            data: {
              familyId: randomUUID(),
              tokenHash: refresh.tokenHash,
              userId: user.id,
              tenantId: tenant.id,
              expiresAt: this.refreshExpiry(),
              ipAddress: input.fingerprint.ipAddress,
              userAgent: input.fingerprint.userAgent,
            },
            select: { tokenHash: true },
          });

          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              actorId: user.id,
              actorEmail: email,
              action: 'TENANT_CREATED',
              target: tenant.slug,
              ipAddress: input.fingerprint.ipAddress,
              userAgent: input.fingerprint.userAgent,
              requestId: input.requestId,
              metadata: { userId: user.id },
            },
          });

          return { tenant, user };
        }),
      'tenant provisioning (rls_tenants_insert permits INSERT only while no tenant is in scope)',
    );

    const tokens = await this.issueTokens({
      tenantId: created.tenant.id,
      userId: created.user.id,
      email: created.user.email,
      role: TenantRole.Owner,
      userStatus: created.user.status,
      isPlatformAdmin: created.user.isPlatformAdmin,
      refreshToken: refresh.token,
    });

    return this.buildSession({
      tokens,
      tenantId: created.tenant.id,
      tenantSlug: created.tenant.slug,
      tenantName: created.tenant.name,
      tenantPlan: created.tenant.plan,
      role: TenantRole.Owner,
      user: created.user,
    });
  }

  /**
   * Verifies credentials against the tenant resolved from the request host.
   *
   * The tenant is an input to the *decision* but never to the *identity*: the
   * user is found by email globally, and only then is their membership in this
   * specific tenant checked. Someone with accounts on two tenants signs in to
   * each on its own subdomain and receives a different session each time.
   */
  async login(input: LoginInput, tenant: RequestTenant): Promise<AuthSession> {
    this.assertTenantServable(tenant);
    const email = normalizeEmail(input.email);

    const user = await this.prisma.unscoped(
      (client) =>
        client.user.findUnique({
          where: { email },
          select: { ...USER_SELECT, passwordHash: true },
        }),
      'sign-in user lookup (users is a global model; there is no tenant_id to scope by)',
    );

    // Verify against a real hash even when no user matched, so "no such user"
    // and "wrong password" cost the same. Returning early is what would make
    // account enumeration over a public login endpoint trivial.
    const passwordMatches = user
      ? await verifyPassword(input.password, user.passwordHash)
      : await this.equalizeTiming();

    if (!user || !passwordMatches || !canSignIn(user.status)) {
      await this.recordSignInFailure(tenant, email, input, 'credential_rejected');
      throw new InvalidCredentialsError();
    }

    // Tenant-scoped, and enforced by RLS. A user who is a member of some other
    // tenant gets `null` here, not a row.
    const membership = await this.requireMembership(tenant.tenantId, user.id);

    // Opportunistic rehash: a password stored under an older scrypt cost is
    // upgraded at the next successful sign-in, so raising the cost does not
    // depend on every user choosing to change their password.
    if (inspectPasswordHash(user.passwordHash, this.env.scryptCost).needsRehash) {
      const upgraded = await hashPassword(input.password, this.env.scryptCost);
      await this.prisma.unscoped(
        (client) =>
          client.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } }),
        'opportunistic password rehash at sign-in',
      );
      this.logger.log(`Rehashed the password for user ${user.id} at the current scrypt cost`);
    }

    const refresh = this.tokens.issueRefreshToken();

    // One transaction for the whole post-verification write: last-login, the
    // audit row and the new refresh family all commit together, so a failure
    // cannot leave a user marked signed-in with no session, or a live refresh
    // token with no audit trail.
    const session = await this.transactions.run(tenant.tenantId, async () => {
      const tx = this.transactions.active;
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

      await tx.refreshToken.create({
        data: {
          familyId: randomUUID(),
          tokenHash: refresh.tokenHash,
          userId: user.id,
          // Named explicitly because `TenantScopedTransaction` is typed as the
          // un-extended client, so the compiler cannot see the query extension
          // that injects this. `applyTenantScopeToArgs` asserts it matches the
          // active scope, so a wrong value still fails at the call site.
          tenantId: tenant.tenantId,
          expiresAt: this.refreshExpiry(),
          ipAddress: input.fingerprint.ipAddress,
          userAgent: input.fingerprint.userAgent,
        },
        select: { tokenHash: true },
      });

      const currentTenant = await tx.tenant.findUnique({
        where: { id: tenant.tenantId },
        select: { name: true },
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.tenantId,
          actorId: user.id,
          actorEmail: user.email,
          action: 'SIGN_IN',
          target: tenant.slug,
          ipAddress: input.fingerprint.ipAddress,
          userAgent: input.fingerprint.userAgent,
          requestId: input.requestId,
          metadata: { role: membership.role },
        },
        select: { tenantId: true },
      });

      const tokens = await this.issueTokens({
        tenantId: tenant.tenantId,
        userId: user.id,
        email: user.email,
        role: membership.role,
        userStatus: user.status,
        isPlatformAdmin: user.isPlatformAdmin,
        refreshToken: refresh.token,
      });

      return this.buildSession({
        tokens,
        tenantId: tenant.tenantId,
        tenantSlug: tenant.slug,
        tenantName: currentTenant?.name ?? '',
        tenantPlan: tenant.plan,
        role: membership.role,
        user,
      });
    });

    return session;
  }

  /**
   * Re-reads the principal for `/auth/me`.
   *
   * Deliberately not a decode of the access token. Role and account status come
   * from the database, so a suspended user or a demoted member loses access on
   * their next request rather than when the access token happens to expire. That
   * read is what makes a 15-minute access token affordable.
   *
   * Issues no tokens. A GET that mutated the session would rotate the refresh
   * token on every page load, which breaks clients that do not write the new
   * value back.
   */
  async me(principal: Principal, tenant: RequestTenant): Promise<AuthSessionView> {
    this.assertTenantServable(tenant);
    this.assertTokenTenant(principal.tenantId, tenant);

    return this.transactions.run(tenant.tenantId, async () => {
      const tx = this.transactions.active;
      const user = await tx.user.findUnique({
        where: { id: principal.userId },
        select: USER_SELECT,
      });
      // The token is valid but the account is not usable. Same error as a bad
      // token, so a client cannot probe which accounts are active.
      if (!user || !canSignIn(user.status)) throw new InvalidCredentialsError();

      // Tenant-scoped: RLS means this returns null for a member of some other
      // tenant, which is exactly the check that matters when a member has been
      // removed since the token was issued.
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.tenantId, userId: user.id } },
        select: { role: true },
      });
      if (!membership) throw new InvalidCredentialsError();

      const currentTenant = await tx.tenant.findUnique({
        where: { id: tenant.tenantId },
        select: { slug: true, name: true, plan: true },
      });

      return this.buildSessionView({
        tenantId: tenant.tenantId,
        tenantSlug: currentTenant?.slug ?? tenant.slug,
        tenantName: currentTenant?.name ?? '',
        tenantPlan: currentTenant?.plan ?? tenant.plan,
        role: membership.role,
        user,
      });
    });
  }

  /**
   * Rotates a refresh token.
   *
   * Looks the token up by hash before any tenant is known — `refresh_tokens` is
   * global by design, because a rotation arrives without a usable tenant
   * context. The tenant then comes out of the row, is checked against the request
   * host, and every subsequent write is tenant-scoped.
   */
  async refresh(
    refreshToken: string,
    tenant: RequestTenant,
    fingerprint: RequestFingerprint,
  ): Promise<AuthSession> {
    this.assertTenantServable(tenant);

    const stored = await this.prisma.unscoped(
      (client) =>
        client.refreshToken.findUnique({
          where: { tokenHash: hashRefreshToken(refreshToken) },
          // No `id`: `refresh_tokens` has no surrogate key, and Prisma's
          // `SelectSubset` does not recurse into `select`, so a bogus field
          // here typechecks and then fails at runtime as "Unknown field".
          select: {
            familyId: true,
            userId: true,
            tenantId: true,
            expiresAt: true,
            revokedAt: true,
            revokedReason: true,
          },
        }),
      'refresh rotation lookup (refresh_tokens is global; must resolve before a tenant is known)',
    );

    if (!stored) throw new TokenRevokedError('unknown token');

    if (stored.revokedAt) {
      // Replay. This token was already rotated or signed out, so the presenter is
      // not the legitimate holder. Revoke the family.
      await this.revokeFamily(stored.familyId, stored.tenantId, REVOKE_REASON.Replay, fingerprint);
      this.logger.warn(
        `Replay of a revoked refresh token in family ${stored.familyId}; the family is revoked.`,
      );
      throw new TokenRevokedError(stored.revokedReason ?? 'token already used');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      await this.revokeFamily(stored.familyId, stored.tenantId, REVOKE_REASON.Expired, fingerprint);
      throw new TokenExpiredError();
    }

    // A token minted for tenant A must not be redeemable against tenant B's
    // subdomain, even though the row itself is globally readable.
    if (stored.tenantId !== tenant.tenantId) {
      this.logger.warn(
        `Refresh token issued for tenant ${stored.tenantId} presented to ${tenant.tenantId}.`,
      );
      throw new TenantMismatchError();
    }

    const next = this.tokens.issueRefreshToken();

    return this.transactions.run(tenant.tenantId, async () => {
      const tx = this.transactions.active;
      // Revoke then reissue inside one transaction. If the insert fails the
      // revoke rolls back too, so the caller keeps a working token instead of
      // being logged out by a partial rotation.
      await tx.refreshToken.update({
        // `tokenHash` is the model's unique selector: `refresh_tokens` has no
        // surrogate id, and looking a token up by its hash is the only lookup
        // this flow performs anyway.
        where: { tokenHash: hashRefreshToken(refreshToken) },
        data: { revokedAt: new Date(), revokedReason: REVOKE_REASON.Rotated },
        select: { tokenHash: true },
      });
      await tx.refreshToken.create({
        data: {
          familyId: stored.familyId,
          tokenHash: next.tokenHash,
          userId: stored.userId,
          tenantId: stored.tenantId,
          expiresAt: this.refreshExpiry(),
          ipAddress: fingerprint.ipAddress,
          userAgent: fingerprint.userAgent,
        },
        select: { tokenHash: true },
      });

      const user = await tx.user.findUnique({
        where: { id: stored.userId },
        select: USER_SELECT,
      });
      if (!user || !canSignIn(user.status)) throw new InvalidCredentialsError();

      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.tenantId, userId: user.id } },
        select: { role: true },
      });
      if (!membership) throw new InvalidCredentialsError();

      const currentTenant = await tx.tenant.findUnique({
        where: { id: tenant.tenantId },
        select: { slug: true, name: true, plan: true },
      });

      const tokens = await this.issueTokens({
        tenantId: tenant.tenantId,
        userId: user.id,
        email: user.email,
        role: membership.role,
        userStatus: user.status,
        isPlatformAdmin: user.isPlatformAdmin,
        refreshToken: next.token,
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.tenantId,
          actorId: user.id,
          actorEmail: user.email,
          action: 'TOKEN_REFRESHED',
          target: currentTenant?.slug ?? tenant.slug,
          ipAddress: fingerprint.ipAddress,
          userAgent: fingerprint.userAgent,
          metadata: { familyId: stored.familyId },
        },
        select: { tenantId: true },
      });

      return this.buildSession({
        tokens,
        tenantId: tenant.tenantId,
        tenantSlug: currentTenant?.slug ?? tenant.slug,
        tenantName: currentTenant?.name ?? '',
        tenantPlan: currentTenant?.plan ?? tenant.plan,
        role: membership.role,
        user,
      });
    });
  }

  /**
   * Revokes every token in the presented token's family.
   *
   * Idempotent: signing out twice, or with a token that never existed, succeeds.
   * A caller asking to end a session should not be told off for the session
   * already being gone.
   */
  async signOut(refreshToken: string, fingerprint: RequestFingerprint): Promise<void> {
    const stored = await this.prisma.unscoped(
      (client) =>
        client.refreshToken.findUnique({
          where: { tokenHash: hashRefreshToken(refreshToken) },
          select: { familyId: true, tenantId: true, userId: true },
        }),
      'sign-out lookup (refresh_tokens is global)',
    );

    if (!stored) return;

    await this.revokeFamily(stored.familyId, stored.tenantId, REVOKE_REASON.SignOut, fingerprint);
    this.logger.log(`Revoked refresh family ${stored.familyId} for user ${stored.userId}`);
  }

  /** Projects verified token claims onto the request principal. */
  toPrincipal(claims: VerifiedAccessToken): Principal {
    return {
      userId: claims.userId,
      tenantId: claims.tenantId,
      email: claims.email,
      role: claims.role,
      userStatus: claims.userStatus,
      isPlatformAdmin: claims.isPlatformAdmin,
      // `memberships` has a composite primary key and no surrogate id, so the
      // stable identifier of a membership is the pair itself.
      membershipId: `${claims.tenantId}:${claims.userId}`,
      jti: claims.jti,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async issueTokens(params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly email: string;
    readonly role: TenantRole;
    readonly userStatus: UserStatus;
    readonly isPlatformAdmin: boolean;
    readonly refreshToken: string;
  }): Promise<IssuedTokens> {
    const access = await this.tokens.issueAccessToken({
      userId: params.userId,
      tenantId: params.tenantId,
      role: params.role,
      email: params.email,
      userStatus: params.userStatus,
      isPlatformAdmin: params.isPlatformAdmin,
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: params.refreshToken,
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.env.refreshTtlSeconds * 1_000);
  }

  /**
   * Burns one scrypt's worth of CPU with no user in context.
   *
   * The constant-time argument holds only if both branches cost the same.
   * Without this, "no such user" returns in microseconds while "wrong password"
   * takes ~70ms, which is a free account-enumeration oracle.
   */
  private async equalizeTiming(): Promise<false> {
    await verifyPassword('not-a-real-password', DUMMY_HASH);
    return false;
  }

  private assertTenantServable(tenant: RequestTenant): void {
    if (!TENANT_SERVABLE_STATUSES.includes(tenant.status) || tenant.suspendedAt !== null) {
      throw new TenantNotServableError(
        `Tenant ${tenant.slug} is ${tenant.status} and cannot serve requests.`,
      );
    }
  }

  private assertTokenTenant(tokenTenantId: string, tenant: RequestTenant): void {
    if (tokenTenantId !== tenant.tenantId) {
      // Logged with both ids because an operator needs to tell a stale tab apart
      // from a real cross-tenant attempt. Neither id reaches the client.
      this.logger.warn(
        `Access token for tenant ${tokenTenantId} was presented to tenant ${tenant.tenantId}.`,
      );
      throw new TenantMismatchError();
    }
  }

  /**
   * Loads the caller's membership in the request's tenant.
   *
   * Runs in a tenant-pinned transaction so RLS is the authority. Under a
   * non-owner role a membership row belonging to another tenant is not returned
   * at all, so `null` means "not authorised here" whether the member was never
   * one or has since been removed.
   */
  private async requireMembership(
    tenantId: string,
    userId: string,
  ): Promise<{ readonly role: TenantRole }> {
    const membership = await this.transactions.run(tenantId, () =>
      this.transactions.active.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { role: true },
      }),
    );

    if (!membership) throw new InvalidCredentialsError();
    return { role: membership.role };
  }

  private async recordSignInFailure(
    tenant: RequestTenant,
    email: string,
    input: LoginInput,
    reason: string,
  ): Promise<void> {
    await this.transactions
      .run(tenant.tenantId, () =>
        this.transactions.active.auditLog
          .create({
            data: {
              tenantId: tenant.tenantId,
              actorEmail: email,
              action: 'SIGN_IN_FAILED',
              target: reason,
              ipAddress: input.fingerprint.ipAddress,
              userAgent: input.fingerprint.userAgent,
              requestId: input.requestId,
              metadata: {},
            },
            select: { tenantId: true },
          })
          .then(() => undefined),
      )
      .catch((error: unknown) => {
        // A failed sign-in must not become a 500, and losing one audit row is not
        // worth failing the request over — but the loss deserves a log line.
        this.logger.warn(`Could not record the sign-in failure for ${email}: ${String(error)}`);
      });
  }

  /**
   * Revokes every unrevoked token in a family.
   *
   * Family-wide, not single-token: once a replay is detected the only safe
   * assumption is that the family is compromised, and revoking just the
   * presented token would leave the attacker's live token working.
   */
  private async revokeFamily(
    familyId: string,
    tenantId: string,
    reason: string,
    fingerprint?: RequestFingerprint,
  ): Promise<void> {
    await this.transactions.run(tenantId, () =>
      this.transactions.active.refreshToken
        .updateMany({
          where: { familyId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revokedReason: reason,
            ipAddress: fingerprint?.ipAddress ?? null,
            userAgent: fingerprint?.userAgent ?? null,
          },
        })
        .then(() => undefined),
    );
  }

  private buildSession(params: {
    readonly tokens: IssuedTokens;
    readonly tenantId: string;
    readonly tenantSlug: string;
    readonly tenantName: string;
    readonly tenantPlan: SubscriptionPlan;
    readonly role: TenantRole;
    readonly user: SessionUserRow;
  }): AuthSession {
    const { tokens } = params;
    return {
      ...this.buildSessionView(params),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: 'Bearer',
      expiresIn: tokens.expiresIn,
    };
  }

  private buildSessionView(params: {
    readonly tenantId: string;
    readonly tenantSlug: string;
    readonly tenantName: string;
    readonly tenantPlan: SubscriptionPlan;
    readonly role: TenantRole;
    readonly user: SessionUserRow;
  }): AuthSessionView {
    const user: SessionUser = {
      id: asUserId(params.user.id),
      email: params.user.email,
      name: params.user.name,
      status: params.user.status as UserStatus,
      isPlatformAdmin: params.user.isPlatformAdmin,
      avatarUrl: params.user.avatarUrl,
    };

    const tenant: SessionTenant = {
      id: asTenantId(params.tenantId),
      slug: params.tenantSlug,
      name: params.tenantName,
      plan: params.tenantPlan,
      role: params.role,
      // One entry, always the active tenant. Listing the caller's other
      // memberships would need an unscoped read across tenants on every sign-in
      // — precisely the query this architecture exists to avoid. A tenant switch
      // is a fresh sign-in against the other tenant's subdomain.
      memberships: [
        {
          tenantId: asTenantId(params.tenantId),
          tenantSlug: params.tenantSlug,
          tenantName: params.tenantName,
          role: params.role,
        },
      ],
    };

    return { user, tenant };
  }
}

/** Columns every auth read needs. One definition, so no query over-fetches. */
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  status: true,
  isPlatformAdmin: true,
  avatarUrl: true,
} as const;

/**
 * A real scrypt hash of an unguessable value, at the production default cost.
 *
 * Its contents are irrelevant; only the work factor matters. It has to be a
 * genuinely well-formed hash so the no-such-user path pays the same ~70ms as a
 * real verification.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$vTzgWVZnvK7LlltoDqTIvw==$' +
  'DPQWBoPlYkrLnq8ma3Ql7cC9T6gRuT+4B3x6g9GgIyWWeUzONGEr2YHi+0poSTTFGvjPP30MEUzeQ1SBvvScBQ==';
