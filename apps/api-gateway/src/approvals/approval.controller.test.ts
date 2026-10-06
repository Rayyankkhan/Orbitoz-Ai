/**
 * The approval HTTP layer: shape validation, route metadata, and the plumbing that
 * carries a request into the service.
 *
 * ---------------------------------------------------------------------------
 * WHY ROUTE METADATA IS ASSERTED HERE RATHER THAN IN A GUARD TEST
 * ---------------------------------------------------------------------------
 * `JwtAuthGuard` defaults to *deny* and switches a route off only on explicit
 * `@Public()`. That default is the safety property; the way to break it is to forget
 * a decorator on one method. Nothing fails at compile time, nothing fails at
 * startup, and the route 401s in production for a human following an email link.
 *
 * A unit test on the guard's own logic would still pass with the decorator missing.
 * Only reflecting on the controller's metadata notices, so that is what this file
 * does — `Reflect.getMetadata` against the same keys the guard reads.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HANDLERS ARE CALLED DIRECTLY
 * ---------------------------------------------------------------------------
 * Everything here is decidable from what the handler passed to the service. Booting
 * a Nest application to find out that `@CurrentTenantId()` reads the response
 * locals would be testing the framework, and `auth.controller.test.ts` already
 * covers the parameter decorators themselves.
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'express';
import {
  ApprovalStatus,
  JobStatus,
  TENANT_DEVELOPER_ROLES,
  TenantRole,
  UserStatus,
  asRequestId,
  asTenantId,
  asUserId,
  type ApprovalDecisionResult,
  type ApprovalView,
} from '@orbitoz/shared-types';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../auth/auth.decorators.js';
import { ApprovalController } from './approval.controller.js';
import { ApprovalNotFoundError } from './approval.errors.js';
import { APPROVAL_TOKEN_LENGTH } from './approval-token.service.js';
import type { AuthenticatedRequest } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/auth.types.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
/** A token with the right shape, so `assertTokenShape` lets it through. */
const TOKEN = 'a'.repeat(APPROVAL_TOKEN_LENGTH);
const NOW_SECONDS = 1_700_000_000;

interface Call {
  readonly name: 'create' | 'view' | 'decide';
  readonly args: readonly unknown[];
}

class RecordingService {
  readonly calls: Call[] = [];
  /** Thrown by whichever method the test names, to drive the error path. */
  failWith: Error | null = null;

  private record(name: Call['name'], args: readonly unknown[]): void {
    this.calls.push({ name, args });
    if (this.failWith !== null) throw this.failWith;
  }

  create(input: unknown): Promise<Record<string, unknown>> {
    this.record('create', [input]);
    return Promise.resolve({
      approvalId: 'approval-1',
      jobId: 'job-1',
      token: TOKEN,
      status: ApprovalStatus.Pending,
      expiresAt: '2027-01-01T00:00:00.000Z',
      approvalPath: `/approvals/${TOKEN}`,
      viewPath: `/approvals/${TOKEN}`,
      requestId: 'req-1',
    });
  }

  getView(tenantId: string, token: string): Promise<ApprovalView> {
    this.record('view', [tenantId, token]);
    return Promise.resolve({
      approval: {
        approvalId: 'approval-1',
        jobId: 'job-1',
        tenantId: asTenantId(TENANT),
        status: ApprovalStatus.Pending,
        model: 'gpt-4o',
        strategy: 'BALANCED',
        maxCostUsd: 5,
        requestedBy: asUserId(USER),
        requestedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
        decidedAt: null,
        decisionNote: null,
        dispatched: false,
      },
      actions: {
        approve: {
          action: 'APPROVE',
          timestamp: String(NOW_SECONDS),
          signature: 'v1=' + 'a'.repeat(64),
        },
        reject: {
          action: 'REJECT',
          timestamp: String(NOW_SECONDS),
          signature: 'v1=' + 'b'.repeat(64),
        },
      },
    });
  }

  decide(input: unknown): Promise<ApprovalDecisionResult> {
    this.record('decide', [input]);
    return Promise.resolve({
      approval: {
        approvalId: 'approval-1',
        jobId: 'job-1',
        tenantId: asTenantId(TENANT),
        status: ApprovalStatus.Approved,
        model: 'gpt-4o',
        strategy: 'BALANCED',
        maxCostUsd: 5,
        requestedBy: asUserId(USER),
        requestedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
        decidedAt: '2026-01-01T00:01:00.000Z',
        decisionNote: null,
        dispatched: true,
      },
      outcome: 'recorded',
      jobStatus: JobStatus.Queued,
      dispatched: true,
      requestId: asRequestId('req-1'),
    });
  }

  /** The single argument the last call received, narrowed for assertions. */
  lastInput<T>(): T {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('no call was recorded');
    return call.args[0] as T;
  }
}

const VALID_BODY = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'wire the money' }],
  maxCostUsd: 5,
};

function controller(service: RecordingService): ApprovalController {
  return new ApprovalController(service as never);
}

function request(headers: Record<string, string> = {}): AuthenticatedRequest {
  return {
    headers,
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as AuthenticatedRequest;
}

/** Stands in for the Express response object `TenantMiddleware` decorates. */
function response(): Response {
  // Cast rather than build a real `Response`: only `locals` is read, and
  // `auth.controller.test.ts` takes the same shortcut for the same reason.
  return {
    locals: {
      requestId: 'req-1',
      tenant: { tenantId: TENANT, slug: 'acme', status: 'ACTIVE' },
    },
  } as unknown as Response;
}

/**
 * A developer, not an admin.
 *
 * `create` is restricted to `TENANT_DEVELOPER_ROLES` rather than to admins,
 * because gating a job is part of developing the workflow that runs it. Using
 * `Admin` here would hide a controller that wrongly required admin: the test would
 * pass for the wrong reason. `AuthSession` is what `auth.controller.test.ts`
 * builds instead, and its fields are all required, so a new one breaks here.
 */
const PRINCIPAL: Principal = {
  userId: USER,
  tenantId: TENANT,
  email: 'dev@acme.test',
  // From the enum rather than the literal: a rename of `Developer` should fail here
  // instead of silently making this principal match no role at all.
  role: TenantRole.Developer,
  userStatus: UserStatus.Active,
  isPlatformAdmin: false,
  membershipId: `${TENANT}:${USER}`,
  jti: 'jti-1',
};

/* -------------------------------------------------------------------------- */
/* Route metadata                                                              */
/* -------------------------------------------------------------------------- */

describe('ApprovalController — route metadata', () => {
  it('leaves the create route authenticated', () => {
    // Parking a job is running it, later. A viewer who could gate a job could stop
    // a workflow or hold one open until it expired, so this must not be public.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ApprovalController.prototype.create)).toBeUndefined();
  });

  it('restricts the create route to tenant developers', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ApprovalController.prototype.create)).toEqual([
      ...TENANT_DEVELOPER_ROLES,
    ]);
  });

  it('marks the view route public', () => {
    // An approver is a person following a link, not a principal. Without this the
    // guard 401s before the handler runs, and the link is simply broken.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ApprovalController.prototype.view)).toBe(true);
  });

  it('marks the decision route public', () => {
    // The decision is authorised by the capability token and its signature, not by a
    // session — see the controller's comment on why GET needs no signature but POST
    // does.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ApprovalController.prototype.decide)).toBe(true);
  });

  it('never inherits a class-level public flag onto the create route', () => {
    // `@Public()` on the class would open the create route too. Asserted separately
    // from the method-level checks so a future refactor that hoists the decorator
    // fails here rather than shipping an open endpoint.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ApprovalController)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* POST /approvals                                                             */
/* -------------------------------------------------------------------------- */

describe('ApprovalController.create', () => {
  let service: RecordingService;

  beforeEach(() => {
    service = new RecordingService();
  });

  it('passes the resolved tenant and principal through', async () => {
    await controller(service).create(
      VALID_BODY,
      PRINCIPAL,
      TENANT,
      request(),
      response(),
      '10.0.0.1',
    );

    const input = service.lastInput<{ tenantId: string; userId: string }>();
    // Never from the body. A client-supplied tenant id is a hint, never an identity.
    expect(input.tenantId).toBe(TENANT);
    expect(input.userId).toBe(USER);
  });

  it('takes the request id from the response locals, not the body', async () => {
    await controller(service).create(
      VALID_BODY,
      PRINCIPAL,
      TENANT,
      request(),
      response(),
      '10.0.0.1',
    );

    // So an approval appears in the audit trail under the same id as the request that
    // created it, even though the client never sent one.
    expect(service.lastInput<{ requestId: string }>().requestId).toBe('req-1');
  });

  it('normalises message fields to explicit nulls', async () => {
    await controller(service).create(
      VALID_BODY,
      PRINCIPAL,
      TENANT,
      request(),
      response(),
      '10.0.0.1',
    );

    // `InferenceMessage` declares `name`/`toolCallId` as `string | null` rather than
    // optional, and a payload restored from JSON months later must have the same
    // shape as a fresh one.
    expect(service.lastInput<{ messages: unknown }>().messages).toEqual([
      { role: 'user', content: 'wire the money', name: null, toolCallId: null },
    ]);
  });

  it('normalises absent options to nulls rather than leaving them undefined', async () => {
    await controller(service).create(
      VALID_BODY,
      PRINCIPAL,
      TENANT,
      request(),
      response(),
      '10.0.0.1',
    );

    const input = service.lastInput<Record<string, unknown>>();
    expect(input.temperature).toBeNull();
    expect(input.maxTokens).toBeNull();
    expect(input.topP).toBeNull();
    expect(input.stopSequences).toBeNull();
    expect(input.responseSchema).toBeNull();
    expect(input.provider).toBeNull();
    expect(input.strategy).toBeNull();
    expect(input.conversationId).toBeNull();
    expect(input.idempotencyKey).toBeNull();
  });

  it('defaults fanout to 1 and passes n through when given', async () => {
    await controller(service).create(
      VALID_BODY,
      PRINCIPAL,
      TENANT,
      request(),
      response(),
      '10.0.0.1',
    );
    expect(service.lastInput<{ fanout: number }>().fanout).toBe(1);

    await controller(service).create(
      { ...VALID_BODY, n: 3 },
      PRINCIPAL,
      TENANT,
      request(),
      response(),
      '10.0.0.1',
    );
    expect(service.lastInput<{ fanout: number }>().fanout).toBe(3);
  });

  it('prefers the first x-forwarded-for address over the socket address', async () => {
    await controller(service).create(
      VALID_BODY,
      PRINCIPAL,
      TENANT,
      request({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'curl/8.0' }),
      response(),
      '10.0.0.1',
    );

    // The gateway sits behind a load balancer, so the socket address is the balancer.
    // An approval audit that recorded only the balancer would be worthless.
    expect(service.lastInput<{ fingerprint: { ipAddress: string } }>().fingerprint.ipAddress).toBe(
      '203.0.113.9',
    );
  });

  it('truncates an over-long user agent to its column width', async () => {
    await controller(service).create(
      VALID_BODY,
      PRINCIPAL,
      TENANT,
      request({ 'user-agent': 'x'.repeat(2_000) }),
      response(),
      '10.0.0.1',
    );

    // A 512-char column. Truncation is the intended behaviour; an insert error on a
    // long user agent is not.
    expect(
      service.lastInput<{ fingerprint: { userAgent: string } }>().fingerprint.userAgent,
    ).toHaveLength(512);
  });

  it('rejects an unknown role in a message', async () => {
    await expect(
      controller(service).create(
        { ...VALID_BODY, messages: [{ role: 'moderator', content: 'hi' }] },
        PRINCIPAL,
        TENANT,
        request(),
        response(),
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Never reaches the service: an invalid body must not create a job.
    expect(service.calls).toEqual([]);
  });

  it('rejects an empty message list', async () => {
    await expect(
      controller(service).create(
        { ...VALID_BODY, messages: [] },
        PRINCIPAL,
        TENANT,
        request(),
        response(),
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.calls).toEqual([]);
  });

  it('rejects a fanout wider than the cap', async () => {
    // One request must not fan out a hundred ways, each of which costs money.
    await expect(
      controller(service).create(
        { ...VALID_BODY, n: 50 },
        PRINCIPAL,
        TENANT,
        request(),
        response(),
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-positive cost cap', async () => {
    await expect(
      controller(service).create(
        { ...VALID_BODY, maxCostUsd: 0 },
        PRINCIPAL,
        TENANT,
        request(),
        response(),
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports each validation problem with its path', async () => {
    const error = await controller(service)
      .create({}, PRINCIPAL, TENANT, request(), response(), '10.0.0.1')
      .catch((thrown: unknown) => thrown);

    const body = (error as BadRequestException).getResponse() as {
      message: readonly { path: string; message: string }[];
    };
    // An array of `{ path, message }`, matching `auth.controller.ts`. A single flat
    // string here would be the inconsistency that module's comment warns about.
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.message.map((issue) => issue.path).sort()).toEqual(['messages', 'model']);
  });

  it('trims a model name', async () => {
    await controller(service).create(
      { ...VALID_BODY, model: '  gpt-4o  ' },
      PRINCIPAL,
      TENANT,
      request(),
      response(),
      '10.0.0.1',
    );

    expect(service.lastInput<{ model: string }>().model).toBe('gpt-4o');
  });

  it('propagates a domain failure unchanged', async () => {
    service.failWith = new ApprovalNotFoundError();

    await expect(
      controller(service).create(VALID_BODY, PRINCIPAL, TENANT, request(), response(), '10.0.0.1'),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /approvals/:token                                                       */
/* -------------------------------------------------------------------------- */

describe('ApprovalController.view', () => {
  let service: RecordingService;

  beforeEach(() => {
    service = new RecordingService();
  });

  it('passes the tenant and token straight through', async () => {
    await controller(service).view(TOKEN, TENANT);

    expect(service.calls).toEqual([{ name: 'view', args: [TENANT, TOKEN] }]);
  });

  it('returns the view as-is', async () => {
    const view = await controller(service).view(TOKEN, TENANT);

    // 200 even for a decided request. The controller's contract is that the approver
    // sees the state, not a 404 that reads like a broken link.
    expect(view.actions.approve.action).toBe('APPROVE');
    expect(view.actions.reject.action).toBe('REJECT');
  });

  it('404s a token of the wrong length without calling the service', async () => {
    await expect(controller(service).view('too-short', TENANT)).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );

    // Otherwise a public endpoint would hash an arbitrary path segment and index into
    // the database on every request.
    expect(service.calls).toEqual([]);
  });

  it('404s a token with characters base64url cannot produce', async () => {
    for (const token of [
      'a'.repeat(APPROVAL_TOKEN_LENGTH - 1),
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}/`,
    ]) {
      await expect(controller(service).view(token, TENANT)).rejects.toBeInstanceOf(
        ApprovalNotFoundError,
      );
    }
    expect(service.calls).toEqual([]);
  });

  it('gives a malformed token the same error as an unknown one', async () => {
    const malformed = await controller(service)
      .view('nope', TENANT)
      .catch((error: unknown) => error);
    service.failWith = new ApprovalNotFoundError();
    const unknown = await controller(service)
      .view(TOKEN, TENANT)
      .catch((error: unknown) => error);

    // The token is a capability. Distinguishing "malformed" from "not yours" would
    // hand an attacker an oracle.
    expect((malformed as { code: string }).code).toBe((unknown as { code: string }).code);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /approvals/:token                                                      */
/* -------------------------------------------------------------------------- */

describe('ApprovalController.decide', () => {
  let service: RecordingService;

  beforeEach(() => {
    service = new RecordingService();
  });

  const validBody = (action = 'APPROVE') => ({
    action,
    timestamp: String(NOW_SECONDS),
    signature: `v1=${'a'.repeat(64)}`,
    note: 'checked',
  });

  it('forwards the parsed decision', async () => {
    await controller(service).decide(TOKEN, validBody('REJECT'), request(), response(), '10.0.0.1');

    const input = service.lastInput<{
      tenantId: string;
      token: string;
      action: string;
      timestamp: string;
      signature: string;
      note: string;
      requestId: string;
    }>();
    expect(input).toMatchObject({
      tenantId: TENANT,
      token: TOKEN,
      action: 'REJECT',
      timestamp: String(NOW_SECONDS),
      signature: `v1=${'a'.repeat(64)}`,
      note: 'checked',
      requestId: 'req-1',
    });
  });

  it('resolves the tenant from the middleware, not the caller', async () => {
    await controller(service).decide(TOKEN, validBody(), request(), response(), '10.0.0.1');

    expect(service.lastInput<{ tenantId: string }>().tenantId).toBe(TENANT);
  });

  it('refuses to decide when no tenant was resolved', async () => {
    const bare = { locals: { requestId: 'req-1' } } as unknown as Response;

    // `TenantMiddleware` 404s before this in the default configuration. The check
    // exists so a single-tenant deployment cannot reach the decision path with
    // nothing to scope the transaction to.
    await expect(
      controller(service).decide(TOKEN, validBody(), request(), bare, '10.0.0.1'),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    expect(service.calls).toEqual([]);
  });

  it('accepts exactly APPROVE and REJECT', async () => {
    for (const action of ['APPROVE', 'REJECT']) {
      await controller(service).decide(TOKEN, validBody(action), request(), response(), '10.0.0.1');
    }
    expect(service.calls.map((call) => call.args.length)).toEqual([1, 1]);
  });

  it('rejects any other action with a 400 before touching the service', async () => {
    // A 400 rather than a 401: the request is malformed, not unauthorised.
    await expect(
      controller(service).decide(TOKEN, validBody('DELETE'), request(), response(), '10.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.calls).toEqual([]);
  });

  it('names the offending field in the rejection', async () => {
    const error = await controller(service)
      .decide(TOKEN, validBody('DELETE'), request(), response(), '10.0.0.1')
      .catch((thrown: unknown) => thrown);

    const body = (error as BadRequestException).getResponse() as {
      message: readonly { path: string }[];
    };
    expect(body.message[0]?.path).toBe('action');
  });

  it('normalises an absent note to null', async () => {
    const { note: _note, ...withoutNote } = validBody();
    await controller(service).decide(TOKEN, withoutNote, request(), response(), '10.0.0.1');

    expect(service.lastInput<{ note: string | null }>().note).toBeNull();
  });

  it('404s a malformed token before validating the body', async () => {
    // Shape first: the token is the capability, and there is no point parsing a
    // decision for a token that cannot exist.
    await expect(
      controller(service).decide('short', validBody(), request(), response(), '10.0.0.1'),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    expect(service.calls).toEqual([]);
  });

  it('rejects a missing signature as a 400', async () => {
    const { signature: _signature, ...withoutSignature } = validBody();

    await expect(
      controller(service).decide(TOKEN, withoutSignature, request(), response(), '10.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.calls).toEqual([]);
  });

  it('rejects an over-long signature as a 400', async () => {
    await expect(
      controller(service).decide(
        TOKEN,
        { ...validBody(), signature: 'x'.repeat(500) },
        request(),
        response(),
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an over-long note as a 400', async () => {
    await expect(
      controller(service).decide(
        TOKEN,
        { ...validBody(), note: 'x'.repeat(5_000) },
        request(),
        response(),
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the approver fingerprint for the audit trail', async () => {
    await controller(service).decide(
      TOKEN,
      validBody(),
      request({ 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0' }),
      response(),
      '10.0.0.1',
    );

    // The decision has no principal, so the IP and user agent are the only record of
    // who clicked.
    expect(
      service.lastInput<{ fingerprint: { ipAddress: string; userAgent: string } }>().fingerprint,
    ).toEqual({ ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0' });
  });

  it('reports a null ip when there is no header and no socket address', async () => {
    await controller(service).decide(TOKEN, validBody(), request(), response(), '');

    expect(
      service.lastInput<{ fingerprint: { ipAddress: string | null } }>().fingerprint.ipAddress,
    ).toBeNull();
  });
});
