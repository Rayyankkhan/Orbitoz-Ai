# `apps/api-gateway`

The HTTP edge: tenant resolution, authentication, request tracing, and enqueueing
inference jobs.

## Request flow

```
Request ─▶ helmet ─▶ TenantMiddleware ─▶ auth guard ─▶ controller ─▶ TenantTransaction.run()
             │              │                                     │
             │              └── resolves Host → tenant,          └── RLS pinned here
             │                  publishes x-tenant-id            │
             └── x-request-id assigned and echoed
```

`TenantMiddleware` resolves the tenant from the `Host` header **before** any
handler runs, because every tenant-owned query depends on knowing which tenant.
It publishes the result as ambient scope but opens no transaction — see
[why](../architecture/multi-tenancy.md#why-middleware-cannot-own-the-transaction).

## Resolving a tenant

`TenantResolver` looks up the host subdomain through the
`app_resolve_tenant(text)` SQL function, which runs with `SECURITY DEFINER`
because the `tenants` table is itself behind RLS — you cannot use RLS to find out
which tenant to apply RLS for.

Results are cached for 60 seconds per host, including negative results for 5
seconds. Without the negative cache every request to an unconfigured host is a
database round trip, which is exactly the shape of a traffic spike on a typo'd
domain.

Tenant identity is not authority. `ResolvedTenant` carries the tenant's id, slug,
name, status, and plan — nothing about what a given caller may do with them.

## Writing a handler

```ts
@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TenantTransaction,
  ) {}

  async list(tenantId: string): Promise<Conversation[]> {
    return this.transactions.run(tenantId, (tx) => tx.conversation.findMany());
  }
}
```

The transaction is the unit of work, not the request. One `run()` per logical
operation, so the pooled connection is released between them.

Do not query tenant data outside `run()`. With RLS enforced, that throws
`TenantTransactionRequiredError` rather than returning an empty list — but it
still fails the request.

## Configuration

`src/config/env.ts` validates everything through Zod at startup. A malformed
value exits during bootstrap instead of surfacing on the first request that
touches it.

`CORS_ORIGINS` accepts either a comma-separated string or an array. The Zod
default is an array, because `.default()` on a piped schema takes the schema's
**output** type.

## Startup checks

`PrismaService.onModuleInit` verifies that Row Level Security is actually
enforced and throws if it is not. This is deliberate: connected as an owner role,
every tenant-scoped query returns zero rows and nothing looks broken. Failing at
startup turns a silent data-availability bug into a visible deploy failure.

## Scripts

| Command      | Purpose                                                     |
| ------------ | ----------------------------------------------------------- |
| `pnpm dev`   | Watch mode. `tsc --watch` emits JS, `node --watch` runs it. |
| `pnpm build` | Typecheck and compile to `dist/`                            |
| `pnpm start` | Run the compiled output                                     |

Nest needs `emitDecoratorMetadata`, which requires `tsc` to do the emitting.
`tsx watch` cannot run this app directly — it strips types without the metadata
the DI container reflects over. That is why `dev` runs two processes in
parallel via `concurrently`.

## Layout

```
src/
  main.ts              bootstrap: helmet, CORS, prefix, filters
  app.module.ts
  common/              exception filter
  config/              env validation (env.ts) and the injectable wrapper
  tenancy/
    tenant.middleware.ts     resolve Host → tenant, publish scope
    tenant.resolver.ts       subdomain lookup, cached
    tenant-transaction.ts    the per-unit-of-work transaction
  health/              liveness + DB round-trip
```
