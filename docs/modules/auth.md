# Auth module (`apps/api-gateway/src/auth`)

Sign-in, session issue, and the guard that protects everything else. For the
design rationale — why two token types, why rotation, why tenant mismatch is 409
— read [authentication.md](../architecture/authentication.md). This file is the
working reference for the code itself.

## Routes

All under the global prefix (`/v1/auth` by default).

| Route            | Guard     | Tenant resolved | Returns                 |
| ---------------- | --------- | --------------- | ----------------------- |
| `POST /register` | `@Public` | **no**          | 201, full `AuthSession` |
| `POST /login`    | `@Public` | yes             | 200, full `AuthSession` |
| `POST /refresh`  | `@Public` | yes             | 200, full `AuthSession` |
| `POST /logout`   | `@Public` | yes             | 204, always             |
| `GET /me`        | guarded   | yes             | 200, `AuthSessionView`  |

Registration returns a full session rather than a bare 201, so a client does not
immediately have to follow up with a sign-in it already holds credentials for.

`logout` is `@Public` deliberately: a client whose access token has expired must
still be able to end its session.

## Which routes skip tenant resolution

`TenantMiddleware` is applied to `auth/*` minus `auth/register`
(`configure()` in `auth.module.ts`). Paths are relative to the global prefix.

A signup arrives before any tenant exists, so no host resolves. Registration's
service opens its own transaction and pins `app.tenant_id` to the tenant it has
just created — see
[registering without a tenant](../architecture/authentication.md#registration-is-the-odd-one-out).

`GET /health` is excluded in `app.module.ts` instead, since it is not an auth
route.

## Making a route public

```ts
@Public()
@Post('login')
async login(/* ... */): Promise<AuthSession> { /* ... */ }
```

The guard is an `APP_GUARD`, so the default is deny and `@Public()` is the only
opt-out. There is no per-route `@UseGuards`, and no base class to remember to
extend.

## Making a route require a role

```ts
@Roles(TenantRole.Owner, TenantRole.Developer)
@Delete('members/:id')
async removeMember(/* ... */) { /* ... */ }
```

Roles are ranked, not compared as strings, so `@Roles(TenantRole.Viewer)`
admits an `OWNER`. The route only states the floor.

Order matters in the guard: tenant match is checked **before** role. A mismatch
reported as a role problem sends the caller to fix the wrong thing.

## Reading the caller

```ts
async list(
  @CurrentUser() user: Principal,
  @CurrentTenantId() tenantId: string,
): Promise<Thing[]> { /* ... */ }
```

`Principal` is derived from verified claims by `AuthService.toPrincipal`. The
`role` and `userStatus` on it are claims, not authority — if a handler needs them
to be current, re-read from the database the way `/auth/me` does.

Both decorators throw if the values are absent, which cannot happen behind the
guard but makes a direct call to the controller fail loudly instead of on
`undefined`.

## Reads off `response.locals`

`TenantMiddleware` writes the resolved tenant and `RequestIdMiddleware` writes
the request id onto `response.locals`, which Express types as
`Record<string, any>`. Use the two accessors rather than indexing it directly:

```ts
import { resolvedTenantOf, requestIdOf } from '../tenancy/request-locals.js';

const tenant = resolvedTenantOf(response);
const requestId = requestIdOf(response);
```

Reading `locals.tenant.tenantId` unchecked is an `any` on exactly the value that
decides which tenant's rows a request may touch.

## Errors

Throw from `auth.errors.ts`. Each error carries a canonical `ErrorCode`, and
`AuthErrorFilter` maps it through `HTTP_STATUS_BY_ERROR_CODE` rather than
hard-coding numbers, so a new error cannot drift from the published contract.

```ts
throw new TokenRevokedError('unknown token');
```

Do not throw `HttpException` from auth code. The filter is registered globally in
`main.ts` and only catches `AuthError`; an `HttpException` from here renders with
the generic filter and loses the canonical code.

Never invent a status for "the token is from another tenant" — use
`TenantMismatchError`. 409 tells the client to re-resolve its tenant, which is a
different action from retrying.

## Body validation

Zod, not `class-validator`. A Zod schema is both the runtime check and the
TypeScript type: `z.infer` is the handler's parameter type, so a renamed field is
a compile error rather than `undefined` at runtime.

Field failures throw `BadRequestException`, rendered as
`{ error, message, requestId }` where `message` is an array of
`{ path, message }` — a client can point at the offending input.

Password policy failures throw `WeakPasswordError`, which carries the per-rule
messages separately from the vague top-level message.

## Fingerprints

`fingerprint(request, ip)` builds the `ipAddress` and `userAgent` recorded on
`refresh_tokens` and `audit_logs`.

- `X-Forwarded-For` is taken from its first entry and truncated to 45 chars (the
  longest textual IPv6 form, matching the `VarChar(45)` column).
- An empty or all-comma header falls through to the socket address. Written out
  explicitly rather than with `||`, because the lint rule pushing toward `??`
  would keep the empty string and store it as the client's address.
- The header is trusted because the gateway is not directly internet-reachable.
  A deployment that terminates client connections itself must set these from its
  own trusted-proxy configuration.

## Global reads are explicit

`users` and `refresh_tokens` are global tables. Reading them outside tenant scope
goes through `prisma.unscoped(...)`, which takes a reason string:

```ts
await this.prisma.unscoped(
  (client) => client.refreshToken.findUnique(/* ... */),
  'refresh rotation lookup (refresh_tokens is global; must resolve before a tenant is known)',
);
```

An unscoped read without that argument is the thing a reviewer should stop on.
Tenant-scoped reads inside these flows must still use
`transactions.run(tenantId, ...)`.

## Prisma and `refresh_tokens`

`refresh_tokens` has no surrogate `id`; `tokenHash` is the model's unique
selector. Two consequences:

- `where` is `{ tokenHash }` and `select` must never include `id`.
- Prisma's `SelectSubset` does not recurse into `select`, so a bogus field there
  typechecks and then fails at runtime as `Unknown field`. No auth query selects
  `id`.

The initial migration creates the table without a primary key constraint — see
[the known defect](../architecture/authentication.md#known-database-defect). Note
that this does **not** break `ON DELETE CASCADE` from `users`: the FK is on
`user_id`, and the column it references is uniquely indexed. Cascade deletes work
and are verified against a live database. The missing PK only means the table
cannot be addressed by row id and cannot itself be an FK target.

## Tests

`vitest.config.ts` covers `src/**`. The auth suite is pure unit tests with fake
Prisma, `TokenService`, and `EnvService` doubles — no database, no network.

| File                      | Covers                                                   |
| ------------------------- | -------------------------------------------------------- |
| `password.test.ts`        | scrypt round trips, malformed hashes, parameter upgrades |
| `token.service.test.ts`   | issue/verify, expiry, signature, claim validation        |
| `auth.types.test.ts`      | password policy, email normalisation, slug validation    |
| `auth.errors.test.ts`     | codes, messages, information leakage                     |
| `jwt-auth.guard.test.ts`  | bearer extraction, tenant match, status, role ranking    |
| `auth.service.test.ts`    | every flow, including RLS pinning order and rotation     |
| `auth.controller.test.ts` | status codes, validation failures, fingerprints          |

`auth.service.test.ts` records the tenant ids pinned via `transactions.run()`,
which is how it asserts _which_ tenant each query was scoped to — the same
property `pnpm db:verify` proves against a live database.

## Configuration

See the table in
[authentication.md](../architecture/authentication.md#configuration). All of it
is validated at startup by `src/config/env.ts`, and the production-only rules
(documented placeholders rejected, access and refresh secrets must differ) live
there too.
