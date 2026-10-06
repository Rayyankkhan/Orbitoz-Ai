/**
 * HTTP surface for authentication.
 *
 * Every route here is `@Public()`: a caller cannot present a token to the
 * endpoints that mint one. They are still tenant-resolved, because sign-in and
 * refresh are both decisions about a specific tenant — but registration is
 * excluded from `TenantMiddleware` itself, because there is no tenant to resolve
 * before one exists. See `auth.module.ts` for the routing table.
 *
 * ---------------------------------------------------------------------------
 * WHY REQUESTS ARE VALIDATED WITH ZOD RATHER THAN class-validator
 * ---------------------------------------------------------------------------
 * `class-validator` validates *classes*, which means the runtime shape and the
 * TypeScript type are two declarations that can drift. A Zod schema is both:
 * `z.infer` produces the handler's parameter type, so a field renamed in the
 * schema is a compile error in the handler rather than an `undefined` at runtime.
 * The gateway already validates its configuration this way; auth using a
 * different mechanism would be the inconsistency.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { z, type ZodType } from 'zod';
import type { Response } from 'express';
import type { AuthSession } from '@orbitoz/shared-types';
import type { AuthSessionView, RequestFingerprint } from './auth.types.js';
import { AuthService, type RequestTenant } from './auth.service.js';
import { Public, type AuthenticatedRequest } from './auth.decorators.js';
import { TenantNotServableError, UnauthenticatedError } from './auth.errors.js';

/* -------------------------------------------------------------------------- */
/* Schemas                                                                      */
/* -------------------------------------------------------------------------- */

const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(200),
  /** DNS label: becomes a subdomain. Lowercased here so the handler's inferred
   *  type is the normalised value, not the raw input. */
  slug: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .transform((value) => value.toLowerCase()),
  adminName: z.string().trim().max(200).default(''),
  adminEmail: z.string().trim().min(3).max(320).email(),
  adminPassword: z.string().min(1).max(200),
});

const loginSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(200),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;

/* -------------------------------------------------------------------------- */
/* Controller                                                                   */
/* -------------------------------------------------------------------------- */

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Creates a tenant and its owner, and signs them in.
   *
   * Returns a full session rather than a bare 201 so the client does not have to
   * immediately follow up with a sign-in it already holds the credentials for.
   */
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string,
  ): Promise<AuthSession> {
    const input = parseBody(registerSchema, body);

    return this.auth.registerTenant({
      organizationName: input.organizationName,
      slug: input.slug,
      adminName: input.adminName,
      adminEmail: input.adminEmail,
      adminPassword: input.adminPassword,
      fingerprint: fingerprint(request, ip),
      requestId: requestIdOf(response),
    });
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string,
  ): Promise<AuthSession> {
    const input = parseBody(loginSchema, body);

    return this.auth.login(
      {
        email: input.email,
        password: input.password,
        fingerprint: fingerprint(request, ip),
        requestId: requestIdOf(response),
      },
      tenantOf(response),
    );
  }

  /**
   * Returns the caller as the database currently sees them.
   *
   * Role and account status come from a fresh read, which is what makes a
   * demotion or a suspension take effect on the member's next request rather
   * than at access-token expiry. Issues no tokens: a GET that rotated the refresh
   * token would break any client that does not write the new value back.
   */
  @Get('me')
  async me(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionView> {
    const principal = request.auth;
    // Unreachable behind JwtAuthGuard, which runs first. Checked anyway so a
    // direct call to the controller fails loudly instead of on `undefined`.
    if (!principal) throw new UnauthenticatedError();

    return this.auth.me(principal, tenantOf(response));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string,
  ): Promise<AuthSession> {
    const input = parseBody(refreshSchema, body);

    return this.auth.refresh(input.refreshToken, tenantOf(response), fingerprint(request, ip));
  }

  /**
   * Revokes the presented token's refresh family.
   *
   * Always 204, including for a token that never existed. A sign-out that can
   * fail tells a client its session may still be alive, and the client has no way
   * to act on that except asking again.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Ip() ip: string,
  ): Promise<void> {
    const input = parseBody(refreshSchema, body);
    await this.auth.signOut(input.refreshToken, fingerprint(request, ip));
  }
}

/* -------------------------------------------------------------------------- */
/* Request plumbing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Validates a body against its schema.
 *
 * Throws a `BadRequestException` carrying the field-level detail, which
 * `HttpExceptionFilter` renders as `{ error, message, requestId }`. The message
 * is an array of `{ path, message }` so a client can point at the offending
 * input rather than showing a generic failure.
 */
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  throw new BadRequestException({
    message: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  });
}

/**
 * Reads the tenant `TenantMiddleware` resolved, off the response locals.
 *
 * Not re-resolved from the host: the middleware already did the lookup, and
 * doing it twice would double the database round trips on every auth request.
 */
function tenantOf(response: Response): RequestTenant {
  const tenant = response.locals?.tenant as
    | {
        tenantId: string;
        slug: string;
        status: string;
        plan: string;
        suspendedAt: string | null;
      }
    | undefined;

  if (!tenant) {
    throw new TenantNotServableError(
      'This request did not resolve a tenant. Sign-in is tenant-scoped; use the tenant subdomain.',
    );
  }

  return {
    tenantId: tenant.tenantId,
    slug: tenant.slug,
    status: tenant.status as RequestTenant['status'],
    plan: tenant.plan as RequestTenant['plan'],
    suspendedAt: tenant.suspendedAt,
  };
}

function requestIdOf(response: Response): string {
  return (response.locals?.requestId as string | undefined) ?? 'unknown';
}

/**
 * Client metadata recorded against refresh tokens and audit rows.
 *
 * `x-forwarded-for` is preferred over the socket address because the gateway runs
 * behind a load balancer in every real deployment, where the socket address is
 * the balancer itself. It is trusted only because the gateway is not directly
 * reachable from the internet; a deployment that terminates client connections
 * itself must set these from its own trusted-proxy configuration instead.
 *
 * Both fields are truncated to the column widths — `ip_address` is `VarChar(45)`,
 * the longest textual IPv6 form, and a longer value becomes a truncation rather
 * than an insert error.
 */
function fingerprint(request: AuthenticatedRequest, ip: string): RequestFingerprint {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  // An empty or all-comma `X-Forwarded-For` carries no address, so it falls through
  // to the socket address. Spelled out rather than written as `||`, because the
  // lint rule pushing towards `??` would keep the empty string — which would then
  // be stored as the client's address instead of being ignored.
  const header = first?.split(',')[0]?.trim() ?? '';
  const candidate = header === '' ? ip : header;

  return {
    ipAddress: candidate ? candidate.slice(0, 45) : null,
    userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
  };
}
