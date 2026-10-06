# Authentication

How the API gateway decides who is calling, and what they may do. Read
[multi-tenancy.md](multi-tenancy.md) first if you are not already familiar with
how a request becomes attributed to a tenant — this document assumes you know
what `TenantMiddleware` publishes and what an RLS-pinned transaction is.

## The separation that makes this safe

A request carries two independent facts:

| Fact                  | Where it comes from   | What it decides                           |
| --------------------- | --------------------- | ----------------------------------------- |
| **Which tenant**      | the `Host` header     | which tenant's rows the request may touch |
| **Who the caller is** | a signed access token | whether they may act, and as what role    |

They are kept apart on purpose. Resolving a host tells you which tenant to apply
RLS for; it says nothing about the caller. If tenant identity implied authority,
a typo'd or spoofed `Host` would be an authorisation bypass, and the token would
be decorative.

The consequence that shows up throughout the code: a valid token issued for
tenant A presented to tenant B's subdomain is refused, not downgraded. It is
`TENANT_MISMATCH` (HTTP 409), not 403.

## Two tokens, because they answer different questions

**Access token** — a short-lived HS256 JWT signed with `jose`. Self-contained, so
verifying it costs one HMAC and no database round trip. Carries `userId`,
`tenantId`, `role`, `email`, `userStatus`, `isPlatformAdmin`, and a `jti`.
Default lifetime 15 minutes.

**Refresh token** — an opaque 32-byte random string (`ort_` + base64url), SHA-256
hashed at rest. It
carries no claims and grants nothing on its own; it exists only to be exchanged
for a new access token. Default lifetime 14 days.

The asymmetry is the point. A JWT cannot be revoked before it expires, so access
tokens are short enough that revocation-by-expiry is acceptable. Refresh tokens
can be revoked immediately, so they are opaque and looked up — one indexed
lookup on a hash, never a decrypt.

### Rotation and the family

Every refresh token belongs to a `familyId`, created when a session starts.
Refreshing revokes the presented token and issues a new one **in the same
transaction**, keeping the family id. So a normal session is a chain of
single-use tokens rather than one long-lived bearer value.

If a token that was already revoked is presented again, the presenter is not the
legitimate holder — the token leaked, or a thief is replaying it. The whole
family is revoked at once and the caller must sign in again. This is the standard
defence against token theft, and it is why rotation is not optional: without it,
a stolen refresh token is indistinguishable from the real one until expiry.

| Action                          | Effect                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `refresh` with a live token     | old row `revokedAt` set to now, new row inserted, same family |
| `refresh` with a used token     | entire family revoked, `TOKEN_REVOKED` returned               |
| `refresh` with an expired token | family revoked, `TOKEN_EXPIRED` returned                      |
| `logout`                        | the presented token's family revoked, always 204              |

`logout` returns 204 even for a token that never existed. A sign-out that can
fail tells a client its session may still be alive, and the client cannot act on
that except by asking again.

## Tenancy inside the auth flow

`users` and `refresh_tokens` are global tables — a person has one account across
tenants and must be able to present a refresh token before the tenant is known.
`memberships` is tenant-scoped, and that is where the actual authority lives.

So sign-in reads the user globally and then reads their membership for the tenant
resolved from the host:

```
POST /auth/login on acme.orbitoz.ai
  └─ unscoped: find user by email              (users is global)
  └─ unscoped: load membership for this tenant (needed before scope exists)
  └─ scoped:   audit log write                 (TenantTransaction.run)
```

Someone with accounts on two tenants signs in on each subdomain and receives a
different session each time. The same email is not the same session.

Every scoped read in these flows goes through `TenantTransaction.run()`, and
every global read is explicit about it: `prisma.unscoped(...)` takes a reason
string naming why bypassing RLS is correct. A global read without that argument
is the thing a reviewer should stop on.

## Registration is the odd one out

`POST /auth/register` is the only route excluded from `TenantMiddleware`
(wiring in `auth.module.ts`). A signup arrives before any tenant exists, so no
host resolves — the service opens its own transaction:

```
$transaction (unscoped, rls_tenants_insert permits INSERT while unset)
  ├─ reject existing user / slug
  ├─ INSERT tenants
  ├─ setRlsTenant(tx, tenant.id)     ← now it is an ordinary scoped transaction
  ├─ INSERT users, memberships, subscriptions, refresh_tokens, audit_logs
```

The tenant is created `TRIALING` on the `FREE` plan with a 14-day trial, and the
denormalised quota columns on `tenants` are written from
`PLAN_ENTITLEMENTS.FREE` so they agree with the `subscriptions` row — both in the
same transaction. The creator becomes `OWNER` and is marked email-verified: they
typed their own address into their own tenant, and there is no mail service yet.

`rls_tenants_insert` is keyed on `app_tenant_unset()`, so the database refuses
this insert for any connection that already has a tenant in scope. The one place
that runs without tenant scope is still constrained by policy rather than by
trust in application code.

The password is hashed **before** the transaction opens. scrypt costs ~70ms of
pure CPU, and holding a pooled connection for that would occupy it for the whole
duration.

## Password hashing

scrypt, in the format `packages/database/prisma/seed.ts` writes, so seeded
credentials verify against the same code path as new signups:

```
scrypt$N$r$p$<salt-base64>$<hash-base64>
```

The parameters live in the encoded string, so raising `AUTH_SCRYPT_N` does not
invalidate existing hashes: verification parses the stored parameters and only
the cost — never the hash — is upgraded on the next successful sign-in.

**scrypt, not bcrypt.** bcrypt silently truncates at 72 bytes, which pushes
length policy work onto every call site, and its parameters are not recoverable
from a stored hash. This format is self-describing.

## Guard: default deny

`JwtAuthGuard` is registered as an `APP_GUARD`, so it has no route to be
forgotten on. The default is deny and `@Public()` is the explicit opt-out. A
per-controller `@UseGuards` shares one failure mode: a new controller in a new
folder is simply unprotected, and nothing complains until someone reviews the
route list.

A protected request must clear, in order:

1. `Authorization: Bearer <token>` present, scheme matched case-insensitively
   (RFC 7235 says so, and rejecting `bearer` would log out real clients)
2. signature valid, `exp`/`nbf`/`iss`/`aud` accepted within clock tolerance
3. token's `tenantId` equals the Host-resolved tenant — otherwise
   `TENANT_MISMATCH`
4. `userStatus` is sign-in-capable
5. role satisfies `@Roles()` (ranked comparison, not string equality)

Tenant is checked **before** role on purpose. A mismatch reported as a role
problem sends the caller to fix the wrong thing.

Rejection reasons are logged with the token's own tenant id — that is what makes
"a valid token for tenant A was refused at tenant B" diagnosable. The client is
told only enough to know whether to refresh.

## The guard re-reads, so status changes are immediate

Access tokens carry `role` and `userStatus`, but those are claims, not authority.
`GET /auth/me` re-reads both from the database, so a demotion or a suspension
takes effect on that call rather than at token expiry.

The guard's own status check reads from the token, because it catches the common
case where the token was minted while the account was already unusable. It is a
cheap early rejection, not the authority.

This is also why access tokens are short: the window in which a stale claim is
carried is bounded by `JWT_ACCESS_TTL`.

## Error codes

Every auth failure is a domain error carrying a canonical `ErrorCode` from
`@orbitoz/shared-types`. Clients switch on the code; the message is for humans
and is deliberately vague where being specific would leak.

| Code                       | Status | When                                              |
| -------------------------- | ------ | ------------------------------------------------- |
| `UNAUTHENTICATED`          | 401    | missing or invalid access token                   |
| `TOKEN_EXPIRED`            | 401    | access token expired — the client should refresh  |
| `TOKEN_REVOKED`            | 401    | refresh token replayed, rotated, or signed out    |
| `INVALID_CREDENTIALS`      | 401    | sign-in failed, account disabled, malformed email |
| `EMAIL_ALREADY_REGISTERED` | 409    | address already has an account                    |
| `SLUG_ALREADY_TAKEN`       | 409    | organization subdomain already in use             |
| `TENANT_MISMATCH`          | 409    | token tenant ≠ Host tenant                        |
| `TENANT_SUSPENDED`         | 403    | tenant is not in a servable state                 |
| `FORBIDDEN`                | 403    | authenticated but not permitted                   |
| `INSUFFICIENT_ROLE`        | 403    | role below the route's requirement                |
| `VALIDATION_FAILED`        | 400    | password policy, email, or slug rejected          |

`INVALID_CREDENTIALS` is one code and one message for "no such user", "wrong
password", "not a member of this tenant", and "account disabled". Distinguishing
them tells an attacker which emails have accounts on a given subdomain — the
reconnaissance step before a credential-stuffing run.

`TENANT_MISMATCH` is 409 rather than 403 so the client can tell "you are pointed
at the wrong subdomain for this session" (usually a stale tab after a tenant
switch) from "you are not allowed to do this", and re-resolve instead of
retrying.

## Configuration

`src/config/env.ts` validates all of it through Zod at startup, so a missing or
malformed secret exits during bootstrap rather than on the first request that
touches it.

| Variable              | Default          | Notes                               |
| --------------------- | ---------------- | ----------------------------------- |
| `JWT_ACCESS_SECRET`   | —                | ≥ 32 bytes; required                |
| `JWT_REFRESH_SECRET`  | —                | ≥ 32 bytes; must differ from access |
| `JWT_ACCESS_TTL`      | `900`            | seconds                             |
| `JWT_REFRESH_TTL`     | `1209600`        | seconds (14 days)                   |
| `JWT_ISSUER`          | `orbitoz.ai`     |                                     |
| `JWT_AUDIENCE`        | `orbitoz.ai:api` |                                     |
| `JWT_CLOCK_TOLERANCE` | `5`              | seconds of accepted skew            |
| `AUTH_SCRYPT_N`       | `16384`          | cost for new hashes                 |
| `AUTH_SCRYPT_R`       | `8`              |                                     |
| `AUTH_SCRYPT_P`       | `1`              |                                     |

Two rules are enforced only when `NODE_ENV=production`, so the documented
`cp .env.example .env` quick start keeps working:

- the documented development placeholders are rejected outright — a truncated
  secret looks exactly like a working one, since an HMAC signs fine with any key
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must differ — sharing a key lets a
  refresh token be presented as an access token

## Known database defect

`refresh_tokens` has no surrogate primary key; `tokenHash` is the unique
selector, and Prisma models it that way. The initial migration
(`20260930072924_init`) creates the table **without a primary key constraint**.

An earlier version of this document claimed two consequences that were both
wrong, and both have been checked against a live PostgreSQL 18 instance rather
than reasoned about:

- **Cascade deletes from `users` do work.** The foreign key is on `user_id`,
  which references `users.id` — and `users.id` _is_ uniquely indexed. A
  referenced column needs a unique index, not a primary key on the referencing
  table. Verified: inserting a token, deleting the user, and counting the
  remaining rows in the same transaction leaves `0`. An earlier draft said the
  cascade "relies on a foreign key that has no unique index to hang from" and
  told callers to delete tokens explicitly. Following that advice would have left
  the FK in place as dead code and added a manual step for a behaviour Postgres
  already provides.
- **There is no migration drift.** `prisma migrate diff --from-migrations
prisma/migrations --to-schema prisma/schema.prisma --exit-code` reports
  `No difference detected` and exits `0`. An earlier draft said the missing PK
  would make `migrate diff` report drift forever.

What remains true: the table has no PK, so it cannot be addressed by row id, no
`REFERENCES` can point at it, and `prisma migrate dev` will not offer to add one
for a model it believes is already keyed. That is a modelling smell rather than a
live defect, and it is pre-existing — not introduced by the auth module.

Worth fixing on its own migration, adding a primary key on `token_hash` or a
surrogate `id`. The migration has to be written by hand: Prisma cannot express
"add a PK to a table that has none" for a model it already considers keyed. Until
then, auth code must keep treating `tokenHash` as the only selector.
