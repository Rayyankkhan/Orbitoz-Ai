# Multi-tenancy and Row Level Security

This is the document to read before changing any code that issues a database
query. The rules here are enforced in three places — TypeScript types, a Prisma
query extension, and Postgres policies — and all three must agree.

## The failure mode this design exists to prevent

The shared-database approach stores every tenant's rows in the same tables,
discriminated by a `tenant_id` column. The obvious enforcement is to remember
`WHERE tenant_id = ?` at every call site. That fails, and it fails quietly:

```ts
// Missing the filter. No type error. No exception. No log line.
return prisma.conversation.findMany();
```

Against an owner-role connection this returns **every tenant's data**. Against an
RLS-enforced connection it returns **zero rows**. The second is worse, because a
missing filter becomes indistinguishable from an empty account: the UI renders
"no conversations", the test passes against a fresh database, and the bug reaches
production before anyone notices that a customer cannot see their own data.

So isolation is moved out of application code and into the database, and the
application is then arranged to fail loudly when it tries to bypass it.

## Three enforcement layers

### 1. Postgres policies — the authority

`packages/database/prisma/rls.sql` enables RLS on all 13 tenant-owned tables and
installs 16 policies. Every policy filters on a GUC:

```sql
current_setting('app.tenant_id', true)::uuid
```

`SET LOCAL`-style config via `set_config('app.tenant_id', $1, true)` is
**transaction-local**: it is discarded on commit or rollback. A pooled connection
therefore cannot carry one tenant's identity into the next request that borrows
it. This is why tenant work happens inside a transaction, and why the value is
never set with a session-scoped `SET`.

### 2. The Prisma query extension — keeps code honest

`withTenantScope()` wraps every model delegate. For each operation it injects
`tenantId` into `where` (reads, updates, deletes) or `data` (creates), via
`applyTenantScopeToArgs()` in `tenant-args.ts`. The same module serves raw
transaction handles, so both paths cannot drift.

If a caller supplies a conflicting `tenantId`, it throws
`TenantScopeError` rather than silently preferring one. A write naming another
tenant is a bug or an attack, and both deserve a stack trace.

There is a subtlety in `create`. Rebuilding the `data` object is what makes
Prisma select the `UncheckedCreateInput` variant. Forwarding the original args
untouched makes it fall back to `CreateInput`, which requires the `tenant`
relation and fails validation. The extension therefore replaces the object even
when it only adds one field.

### 3. Role privileges — makes the database disagree if 1 and 2 are bypassed

`packages/database/prisma/roles.sql` provisions `orbitoz_app`:

```sql
CREATE ROLE orbitoz_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
```

`NOBYPASSRLS` is the load-bearing attribute. An owner role bypasses RLS
unconditionally, so an application connected as the owner gets no isolation at
all — the policies are never consulted. `NOSUPERUSER` prevents escalating to a
role that does bypass.

`orbitoz_app` receives `SELECT/INSERT/UPDATE/DELETE` on the tenant tables and
`USAGE` on the sequences. It receives **no** grant on `_prisma_migrations`, so
it cannot alter schema or history.

### Why the owner role still exists

Migrations and the seed need `CREATE TABLE`, `ALTER TABLE`, and ownership of the
policies. That is what `DIRECT_DATABASE_URL` is for. The split is:

| Variable              | Role              | Used by                              |
| --------------------- | ----------------- | ------------------------------------ |
| `DATABASE_URL`        | `orbitoz_app`     | Application services                 |
| `APP_DATABASE_URL`    | `orbitoz_app`     | Same, for deploys that separate them |
| `DIRECT_DATABASE_URL` | `orbitoz` (owner) | Migrations, seed, verification       |
| `SHADOW_DATABASE_URL` | `orbitoz` (owner) | `prisma migrate` shadow database     |

Running an application as the owner silently disables tenant isolation while
still appearing to work. That is why `PrismaService` checks enforcement at
startup instead of trusting configuration.

## Resolving a tenant before a tenant exists

Policies need `app.tenant_id`, but to find out which tenant a request belongs to
you must query `tenants` — which is itself behind RLS. Bootstrapping that from
application SQL would require either an owner connection (defeating the purpose)
or disabling RLS for the lookup (a race).

`app_resolve_tenant(text)` breaks the cycle. It is `SECURITY DEFINER`, so it runs
as its owner and sees all tenants, but it only accepts a `text` argument and only
returns the columns needed to identify a tenant:

```sql
SELECT * FROM app_resolve_tenant('acme.orbitoz.ai');
```

`REVOKE EXECUTE ... FROM PUBLIC` in `rls.sql` limits it to `orbitoz_app`. It is
not a general-purpose "read any tenant's data" escape hatch, which is why the
privilege is granted explicitly rather than assumed.

`TENANT_REQUIRED=false` switches on single-tenant mode, where an unresolvable
host is served instead of 404ing. Default is `true`: a DNS mistake should return
an error rather than merge two tenants' traffic into one account.

## Transactions are the unit of work

Because `app.tenant_id` is transaction-local, any query that must see tenant data
has to run inside a transaction that pinned it. This is the sharpest edge in the
system, and the ergonomic answer is deliberately narrow:

```ts
const conversations = await this.transactions.run(tenant.tenantId, async (tx) =>
  tx.conversation.findMany(),
);
```

Three rules follow:

- **One transaction per unit of work, not per request.** Holding a pooled
  connection for a client's entire think-time exhausts the pool long before the
  database is slow. `TenantMiddleware` deliberately opens _no_ transaction.
- **Never wrap a transaction handle in `withTenantScope()`.** Prisma 7 transaction
  handles have no `$extends`; the extension is inherited from the extended client
  that opened the transaction. Calling it anyway fails.
- **A worker has no request to inherit a scope from.** It establishes one per job
  from the job envelope, never from ambient state.

### Why middleware cannot own the transaction

A transaction opened in Nest middleware around a callback that calls `next()`
commits the instant the middleware returns — before the route handler has awaited
anything. Handlers then read through a committed, unpinned connection and get
nothing. The bug is invisible without a non-owner role.

`AsyncLocalStorage` has no such problem, because context propagates to async work
_started_ inside the scope. So middleware publishes identity:

```ts
runWithTenant({ tenantId, requestId, rlsPinned: false }, () => next());
```

and handlers open the transaction that RLS is pinned in.

`rlsPinned` records whether a transaction is actually backing the current scope.
When enforcement is on, a tenant-scoped query outside a pinned transaction throws
`TenantTransactionRequiredError` instead of returning an empty result.

`runWithTenant` subscribes to returned thenables **synchronously**. Prisma query
builders are lazy; without this, a query created inside the scope but awaited
outside it would read the wrong ambient store.

## Verifying it

`pnpm db:verify` runs 30 checks against a live database as `orbitoz_app`:

1. Every model in the schema is classified tenant-scoped or global
2. Two tenants, created with no cross-visibility
3. Extension scoping — each sees exactly its own rows
4. An unpinned query **throws** rather than returning zero rows; a create naming a
   foreign `tenantId` is rejected
5. Every RLS-protected tenant table is registered, and nothing is registered
   without a policy
6. RLS — reads, writes, and updates are all filtered; a cross-tenant write fails
   with `42501`
7. Tenant resolution works under enforcement
8. Control: the owner role sees every tenant's rows
9. Approval tokens — another tenant's token resolves to **no row at all**, and the
   atomic `PENDING` claim matches one row then zero

That last check matters more than it looks. Without it, a test that passes
because RLS was never enabled looks identical to a test that passes because RLS
worked. The control proves the assertions discriminate.

## Adding a tenant-scoped model

1. Add the model to `schema.prisma` with a `tenantId` field and a composite
   `@@unique` / `@@id` that starts with `tenantId`.
2. Add its table to `tenant_tables` in `rls.sql`.
3. Add its name to `TENANT_SCOPED_MODELS` in `packages/database/src/client/tenant-models.ts`.
4. Add its **table** name to `TENANT_TABLE_REGISTRY` in
   `packages/database/src/client/prisma.tokens.ts`.

Steps 3 and 4 are not optional bookkeeping, and they fail differently on purpose.
`unclassifiedModels()` compares your list against `Prisma.ModelName` — generated
from the schema, so it cannot drift — and `pnpm db:verify` fails on any model you
forgot. A new table with no policy would otherwise be readable by every tenant.

`TENANT_TABLE_REGISTRY` is the one hand-maintained list in this layer, because its
consumers read `pg_catalog` and cannot see Prisma's model names. So `db:verify`
checks it against the catalog in both directions: a protected table that is not
registered is invisible to whatever runs next, and a registered table with no
policy is worse — callers would trust a control that is not there. A table that
deliberately opts out of RLS has to be named in the check itself, so "correct by
omission" does not quietly become "correct by accident"; `refresh_tokens` is the
only one today, because rotation has to resolve a token before a tenant is known.

Names in `TENANT_SCOPED_MODELS` are **PascalCase** (`'InferenceJob'`). Prisma 7
passes the schema name to extensions, not the camelCase client property. Names in
`TENANT_TABLE_REGISTRY` are the Postgres table names (`'inference_jobs'`).
