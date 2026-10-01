# `@orbitoz/database`

Schema, migrations, RLS policies, and the tenant-scoped Prisma client. Everything
else in the repo gets its database access from here.

## Clients: two, and the difference matters

| Factory                   | Tenant scoping                     | Used by                        |
| ------------------------- | ---------------------------------- | ------------------------------ |
| `createPrismaClient()`    | **yes** — every delegate is scoped | Application services           |
| `createRawPrismaClient()` | no — plain client                  | Migrations, seed, verification |

`createPrismaClient()` is the default and the one you want. `createRawPrismaClient`
is the explicit escape hatch: it is the only way to read across tenants, and
using it in a request handler reintroduces exactly the class of bug this package
exists to prevent.

```ts
const prisma = createPrismaClient(); // scoped
const admin = createRawPrismaClient({ connectionString }); // unscoped, deliberate
```

Import from `../src/client/prisma-factory.js` rather than the package barrel when
running through `tsx`. The barrel also re-exports `PrismaService`, which carries
Nest decorators that esbuild cannot transform.

## Tenant scope

```ts
import { runWithTenant } from '@orbitoz/database';

await runWithTenant({ tenantId }, async () => {
  await prisma.conversation.findMany(); // scoped to tenantId
});
```

The scope is ambient and propagates to async work started inside it. Queries
created inside the scope but awaited outside it will not see it.

## Transactions

```ts
await prismaService.withTenant(tenantId, async (tx) => {
  await tx.conversation.create({ data: { title: 'hello' } });
});
```

`withTenant` opens an interactive transaction, pins `app.tenant_id` with
`set_config(..., true)`, and re-exposes the transaction's **own extended
client**. Scoping and RLS are both already in force.

Do not call `withTenantScope(tx)` on the handle. Prisma 7 transaction handles
have no `$extends`, and the extension is inherited from the client that opened
the transaction.

## Detecting an unpinned query

Once enforcement is detected, the extension refuses to run a tenant-scoped query
outside a pinned transaction:

```
TenantTransactionRequiredError: this query needs a tenant transaction.
Wrap it in withTenant() or TenantTransaction.run().
```

This is deliberate. The alternative — returning an empty result set — is
indistinguishable from a legitimately empty query, which is how an isolation bug
reaches production. See
[multi-tenancy.md](../architecture/multi-tenancy.md).

## Model classification

`tenant-models.ts` splits the schema into `TENANT_SCOPED_MODELS` and
`GLOBAL_MODELS`, using **PascalCase** names (`'InferenceJob'`) because Prisma 7
passes the schema name to extensions, not the client property.

```ts
import { unclassifiedModels, Prisma } from '@orbitoz/database';

unclassifiedModels(Object.values(Prisma.ModelName));
// [] — anything you forgot to classify shows up here, and db:verify fails.
```

`Prisma.ModelName` is generated from `schema.prisma`, so this comparison cannot
drift the way a hand-maintained list would.

## SQL files

| File                 | Applied by       | Contents                                                 |
| -------------------- | ---------------- | -------------------------------------------------------- |
| `prisma/migrations/` | `prisma migrate` | Schema history                                           |
| `prisma/roles.sql`   | `pnpm db:roles`  | `orbitoz_app` role, grants, default privileges           |
| `prisma/rls.sql`     | `pnpm db:rls`    | RLS policies, `app_current_tenant`, `app_resolve_tenant` |

`pnpm db:setup` runs them in the order `migrate → roles → rls → seed`.

Both SQL files are idempotent, so re-running them is safe. `roles.sql` hardcodes
the database name in `GRANT CONNECT`; change it if yours differs. The role
password in `roles.sql` is a development placeholder — production roles should be
provisioned by the platform, not by a checked-in script.

## Scripts

| Command                                    | Purpose                                    |
| ------------------------------------------ | ------------------------------------------ |
| `pnpm --filter @orbitoz/database generate` | Regenerate the client                      |
| `pnpm db:migrate`                          | Create and apply a migration (development) |
| `pnpm db:migrate:deploy`                   | Apply migrations (CI/production)           |
| `pnpm db:roles`                            | Apply `roles.sql`                          |
| `pnpm db:rls`                              | Apply `rls.sql`                            |
| `pnpm db:seed`                             | Idempotent development seed                |
| `pnpm db:verify`                           | 21-check tenant isolation proof            |

## Two TypeScript projects

`tsconfig.json` builds `src/` to `dist/`. `tsconfig.scripts.json` typechecks
`prisma.config.ts`, `prisma/seed.ts`, and `scripts/verify-tenancy.ts`, which live
outside `src/`. Both run in `pnpm typecheck`; without the second, those files
would ship unchecked.

`src/generated/` is excluded from ESLint but still typechecked. It is regenerated
on every `prisma generate`, so linting it would report problems in code nobody
edits.

## Seed

`pnpm db:seed` is idempotent — re-running it updates in place rather than
appending. It runs against `DIRECT_DATABASE_URL`, because seeding needs to create
tenants and would be blocked by RLS as `orbitoz_app`.

The demo API key uses a **fixed prefix** (`of_demo_000`) with a fresh random
secret. The stable prefix is what lets `deleteMany` find the previous run's key;
a prefix derived from the random secret never matches, so every run would append
another key and the previously printed one would stop working.
