/**
 * HTTP surface for human-in-the-loop approvals.
 *
 * ---------------------------------------------------------------------------
 * ROUTING TABLE
 * ---------------------------------------------------------------------------
 * Three routes on one controller, split by *who* is calling:
 *
 *   POST /approvals           `@Roles(DEVELOPER+)` — an authenticated tenant
 *                            developer parks a job and gets a link. Tenant
 *                            resolved by `TenantMiddleware`, exactly like every
 *                            other authenticated route.
 *
 *   GET  /approvals/:token    `@Public()` — the approver's page. No access token:
 *                            they are a person following a link, not a principal.
 *                            Token-gated only; see the note on signatures below.
 *
 *   POST /approvals/:token    `@Public()` + signature. The state-changing one,
 *                            and the only route here where the HMAC is checked.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PUBLIC ROUTES ARE STILL TENANT-RESOLVED
 * ---------------------------------------------------------------------------
 * `TenantMiddleware` runs for `*` apart from `/health`, so a request to
 * `/approvals/:token` on `acme.orbitoz.ai` resolves tenant Acme — and the token
 * lookup then runs inside that tenant's RLS-pinned transaction. A token belonging
 * to another tenant is not "compared and refused": it is invisible, and the
 * service raises `APPROVAL_NOT_FOUND` from a null.
 *
 * That is what makes tenant-context validation structural rather than a line of
 * code someone has to remember to write in a new handler. It also means the
 * emitted link is tenant-scoped by construction, which is why
 * `ApprovalRequestCreated.approvalPath` is a relative path — assembling an
 * absolute URL from the `Host` header would be a redirect primitive aimed
 * wherever the attacker asked.
 *
 * ---------------------------------------------------------------------------
 * WHY `GET` NEEDS NO SIGNATURE BUT `POST` DOES
 * ---------------------------------------------------------------------------
 * The signature binds a grant to one approval request, one action and a short
 * window. A read-only view has no action to bind and changes nothing, so gating it
 * would only make the link unopenable in a browser — the approver cannot compute
 * an HMAC. The state-changing POST is where a tampered `action` would do damage,
 * and that is where the signature is required.
 *
 * ---------------------------------------------------------------------------
 * WHY ZOD, LIKE `auth.controller.ts`
 * ---------------------------------------------------------------------------
 * `z.infer` produces the handler's parameter type, so renaming a field in the
 * schema is a compile error in the handler rather than an `undefined` at runtime.
 * Validating with a different mechanism here would be the inconsistency that
 * module's comment warns against.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { z, type ZodType } from 'zod';
import type { Response } from 'express';
import {
  AiProvider,
  RoutingStrategy,
  TENANT_DEVELOPER_ROLES,
  parseApprovalAction,
  type ApprovalDecisionResult,
  type ApprovalRequestCreated,
  type ApprovalView,
  type InferenceMessage,
} from '@orbitoz/shared-types';
import {
  CurrentTenantId,
  CurrentUser,
  Public,
  Roles,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { Principal } from '../auth/auth.types.js';
import { requestIdOf, resolvedTenantOf } from '../tenancy/request-locals.js';
import {
  ApprovalService,
  type CreateApprovalInput,
  type DecideApprovalInput,
} from './approval.service.js';
import { looksLikeApprovalToken } from './approval-token.service.js';
import { ApprovalNotFoundError } from './approval.errors.js';

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `boundedInt` exists because three of these fields have the same shape and
 * writing the chain out three times invites one of them to drift to a different
 * bound than its neighbours.
 */
function boundedInt(min: number, max: number): z.ZodType<number> {
  return z.coerce.number().int().min(min).max(max);
}

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().min(1).max(200_000),
  name: z.string().max(128).optional(),
  toolCallId: z.string().max(128).optional(),
});

const optionsSchema = z.object({
  temperature: z.coerce.number().min(0).max(2).optional(),
  maxTokens: boundedInt(1, 1_000_000).optional(),
  topP: z.coerce.number().min(0).max(1).optional(),
  // Bounded at 4 because that is what providers accept, and an unbounded array
  // here becomes an unbounded `stop` list sent on every attempt of every retry.
  stopSequences: z.array(z.string().min(1).max(128)).max(4).optional(),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
});

const createApprovalSchema = z.object({
  model: z.string().trim().min(1).max(128),
  messages: z.array(messageSchema).min(1).max(200),
  provider: z.enum(Object.values(AiProvider) as [string, ...string[]]).optional(),
  strategy: z.enum(Object.values(RoutingStrategy) as [string, ...string[]]).optional(),
  options: optionsSchema.optional(),
  /** Fan-out width for comparison mode. Capped so one request cannot fan 100 ways. */
  n: boundedInt(1, 5).optional(),
  maxCostUsd: z.coerce.number().positive().max(10_000).optional(),
  conversationId: z.uuid().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

/**
 * The decision body.
 *
 * `action` is validated by `parseApprovalAction` rather than by a Zod enum so
 * the accepted values come from `APPROVAL_ACTIONS` — one definition, shared with
 * the type. A second list here would be a second answer to "what may an approver
 * do", and the two would drift.
 */
const decideApprovalSchema = z.object({
  action: z.string().min(1).max(16),
  timestamp: z.string().min(1).max(32),
  signature: z.string().min(1).max(128),
  note: z.string().max(2_000).optional(),
});

export type CreateApprovalBody = z.infer<typeof createApprovalSchema>;
export type DecideApprovalBody = z.infer<typeof decideApprovalSchema>;

/* -------------------------------------------------------------------------- */
/* Controller                                                                   */
/* -------------------------------------------------------------------------- */

@Controller('approvals')
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  /**
   * Parks a job and returns the link an approver opens.
   *
   * 201 with the token in the body rather than a `Location` header: the caller is
   * a service that has to email or message the link on, so it needs to read the
   * token, not follow a redirect.
   *
   * Restricted to the same roles that may run inference. Parking a job is running
   * it, later — a viewer who could gate a job could use it to stop a workflow or
   * to hold one open until it expires, which is a privileged act.
   */
  @Roles(...TENANT_DEVELOPER_ROLES)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @CurrentUser() principal: Principal,
    @CurrentTenantId() tenantId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string,
  ): Promise<ApprovalRequestCreated> {
    const input = parseBody(createApprovalSchema, body);

    return this.approvals.create({
      tenantId,
      userId: principal.userId,
      requestId: requestIdOf(response),
      model: input.model,
      messages: input.messages.map(toInferenceMessage),
      provider: (input.provider as AiProvider | undefined) ?? null,
      strategy: (input.strategy as RoutingStrategy | undefined) ?? null,
      temperature: input.options?.temperature ?? null,
      maxTokens: input.options?.maxTokens ?? null,
      topP: input.options?.topP ?? null,
      stopSequences: input.options?.stopSequences ?? null,
      responseSchema: input.options?.responseSchema ?? null,
      fanout: input.n ?? 1,
      idempotencyKey: input.idempotencyKey ?? null,
      maxCostUsd: input.maxCostUsd ?? null,
      conversationId: input.conversationId ?? null,
      fingerprint: fingerprint(request, ip),
    } satisfies CreateApprovalInput);
  }

  /**
   * The page an approver opens.
   *
   * 200 even for a decided or expired request, with the state in the body: an
   * approver who opens a link someone else already used should see "already
   * decided", which is information, rather than a 404 that reads like a broken
   * link.
   */
  @Public()
  @Get(':token')
  async view(
    @Param('token') tokenParam: string,
    @CurrentTenantId() tenantId: string,
  ): Promise<ApprovalView> {
    return this.approvals.getView(tenantId, assertTokenShape(tokenParam));
  }

  /**
   * Records the decision and, on approval, resumes the job.
   *
   * 200 for both a first decision and a replay. A webhook sender that retries
   * after losing a response must not be handed a 409 for something it already did
   * successfully — the outcome field and `dispatched` say which happened.
   */
  @Public()
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('token') tokenParam: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string,
  ): Promise<ApprovalDecisionResult> {
    const input = parseBody(decideApprovalSchema, body);
    const token = assertTokenShape(tokenParam);
    const action = parseApprovalAction(input.action);
    if (action === null) {
      // A 400 rather than a 401: the request is malformed, not unauthorised, and
      // an approver who somehow got a bad `action` needs to be told to reload.
      throw new BadRequestException({
        message: [{ path: 'action', message: 'must be APPROVE or REJECT' }],
      });
    }

    const tenant = resolvedTenantOf(response);
    if (!tenant) {
      // `TenantMiddleware` 404s before this when a tenant is required, so this is
      // unreachable in the default configuration. Checked anyway so a single-tenant
      // deployment cannot reach the decision path without a tenant to scope it to.
      throw new ApprovalNotFoundError();
    }

    return this.approvals.decide({
      tenantId: tenant.tenantId,
      token,
      action,
      timestamp: input.timestamp,
      signature: input.signature,
      note: input.note ?? null,
      fingerprint: fingerprint(request, ip),
      requestId: requestIdOf(response),
    } satisfies DecideApprovalInput);
  }
}

/* -------------------------------------------------------------------------- */
/* Request plumbing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Rejects a token that cannot be one of ours, before any database work.
 *
 * A 404 rather than a 400: the token is a capability, and a malformed one is
 * indistinguishable from an unknown one as far as the caller is concerned.
 * Without this a public endpoint would hash and index-look-up an arbitrarily
 * long path segment on every request.
 */
function assertTokenShape(tokenParam: string): string {
  if (!looksLikeApprovalToken(tokenParam)) throw new ApprovalNotFoundError();
  return tokenParam;
}

/** See `auth.controller.ts` — the message is an array of `{ path, message }`. */
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
 * Normalises one chat message onto the queue contract.
 *
 * `name` and `toolCallId` become explicit `null`s rather than being omitted,
 * because `InferenceMessage` declares them as `string | null` rather than
 * optional — and a queued payload restored from JSON months later must have the
 * same shape as a fresh one.
 */
function toInferenceMessage(message: z.infer<typeof messageSchema>): InferenceMessage {
  return {
    role: message.role,
    content: message.content,
    name: message.name ?? null,
    toolCallId: message.toolCallId ?? null,
  };
}

/**
 * Client metadata for the approval audit trail.
 *
 * Reuses `auth.controller.ts`'s reasoning verbatim: `x-forwarded-for` is preferred
 * over the socket address because the gateway sits behind a load balancer, and
 * both fields are truncated to their column widths so a long user agent is a
 * truncation rather than an insert error.
 */
function fingerprint(
  request: AuthenticatedRequest,
  ip: string,
): {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
} {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const header = first?.split(',')[0]?.trim() ?? '';
  const candidate = header === '' ? ip : header;

  return {
    ipAddress: candidate ? candidate.slice(0, 45) : null,
    userAgent: request.headers['user-agent']?.slice(0, APPROVAL_USER_AGENT_LIMIT) ?? null,
  };
}

/** `decision_user_agent` is `VarChar(512)`. */
const APPROVAL_USER_AGENT_LIMIT = 512;
