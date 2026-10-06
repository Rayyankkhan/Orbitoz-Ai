/**
 * End-to-end verification of tenant isolation.
 *
 *   pnpm db:verify:tenancy
 *
 * Requires:  pnpm db:setup   (migrate + roles + rls)
 * Needs APP_DATABASE_URL — the RLS section only means something when it
 * connects as the unprivileged application role rather than the migration role.
 *
 * Four independent layers, in the order an attacker would meet them:
 *   0. Structural  — every model is explicitly classified as scoped or global.
 *   1. Extension   — a query with no `where` is automatically tenant-scoped.
 *   2. Fail-closed — an unscoped query throws instead of returning everything.
 *   3. RLS         — the database itself hides other tenants' rows, verified as
 *                    a non-owner role, with a control case proving the check
 *                    can actually tell enforced from un-enforced.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  createRawPrismaClient,
  runWithTenant,
  setRlsEnforcement,
  setRlsTenant,
  TenantScopeError,
  TenantTransactionRequiredError,
  unclassifiedModels,
} from '../dist/index.js';
import { GLOBAL_MODELS, TENANT_SCOPED_MODELS } from '../dist/client/tenant-models.js';
import { TENANT_TABLE_REGISTRY } from '../dist/client/prisma.tokens.js';
import { Prisma } from '../dist/generated/prisma/client.js';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = ''): void {
  checks += 1;
  if (passed) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** The database named in a Postgres connection string, or 'unknown'. */
function databaseNameOf(url: string | undefined): string {
  if (!url) return 'unset';
  return new URL(url).pathname.replace(/^\//, '') || 'unknown';
}

/**
 * A `token_hash`-shaped value for a label.
 *
 * Deliberately not the gateway's `hashApprovalToken`. These tokens are minted here,
 * used here and never leave the database, so sharing the definition would add a
 * package dependency (database → app) in exchange for nothing. What matters for the
 * checks below is only that the value is 64 hex characters and deterministic.
 */
function tokenHashFor(label: string): string {
  return createHash('sha256').update(`verify-approval:${label}`, 'utf8').digest('hex');
}

/** Job ids of the `AWAITING_APPROVAL` rows seeded per tenant, for [4g]. */
const gatedJobIds = new Map<string, string>();

/**
 * The owner connection, created up front so `cleanup()` can always reach it.
 *
 * Creating it inside `main()` would mean a throw before that point left the script
 * with nothing to clean up with — which is the situation that produced stray
 * `verify-*` tenants in a development database in the first place.
 */
const ownerClient = createRawPrismaClient({ connectionString: process.env.DIRECT_DATABASE_URL });

/**
 * Every client opened during the run, so {@link cleanup} can close all of them.
 *
 * Tracked rather than closed where they are opened because the run can throw at any
 * point, and a verification script that leaks connections on failure also leaks the
 * rows it created. `ownerClient` is deliberately not in here: it is created at module
 * scope and closed separately, so it exists even if nothing else did.
 */
const openClients: ReturnType<typeof createRawPrismaClient>[] = [];

async function main(): Promise<void> {
  const prisma = createPrismaClient({ connectionString: process.env.DIRECT_DATABASE_URL });
  openClients.push(prisma);

  console.log('\n[0] Every model is classified as tenant-scoped or global');
  // Prisma.ModelName is generated from schema.prisma, so this list cannot drift
  // from the schema the way a hand-maintained one would.
  const allModels = Object.values(Prisma.ModelName) as string[];
  const missing = unclassifiedModels(allModels);
  check(
    `all ${allModels.length} models are classified`,
    missing.length === 0,
    `unclassified: ${missing.join(', ')}`,
  );
  check(
    'the two sets do not overlap',
    [...TENANT_SCOPED_MODELS].every((m) => !GLOBAL_MODELS.has(m)),
  );

  console.log('\nSeeding two isolated tenants…');
  for (const [tenantId, name] of [
    [TENANT_A, 'Tenant A'],
    [TENANT_B, 'Tenant B'],
  ] as const) {
    // Unique slug per run so a previous aborted run cannot collide on
    // tenants_slug_key; the id is explicit so cleanup is exact.
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: {
        id: tenantId,
        slug: `verify-${tenantId.slice(0, 8)}`,
        name,
      },
    });
  }

  const conversationIds = new Map<string, string>();
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await runWithTenant({ tenantId }, async () => {
      // No tenantId in the payload — the extension supplies it at runtime,
      // which the static type cannot know, hence the cast. Supplying tenantId
      // here instead would make this check prove nothing.
      const created = await prisma.conversation.create({
        data: { title: `owned by ${tenantId}` } as Prisma.ConversationUncheckedCreateInput,
      });
      conversationIds.set(tenantId, created.id);

      // Also seeded here, for [4g]: an approval row needs a real job to gate, because
      // the foreign key is on (tenant_id, job_id). Created through the tenant's own
      // scope so the composite key really belongs to it.
      const gated = await prisma.inferenceJob.create({
        data: {
          requestedModel: 'gpt-4o',
          routingStrategy: 'BALANCED',
          status: 'AWAITING_APPROVAL',
        } as never,
      });
      gatedJobIds.set(tenantId, gated.id);
    });
  }

  console.log('\n[1] Extension scoping');
  for (const tenantId of [TENANT_A, TENANT_B]) {
    const seen = await runWithTenant({ tenantId }, () => prisma.conversation.findMany());
    check(
      `${tenantId.slice(0, 8)} sees exactly its own conversation`,
      seen.length === 1 && seen[0]?.title === `owned by ${tenantId}`,
      `got ${JSON.stringify(seen.map((c) => c.title))}`,
    );
  }

  const all = await runWithTenant({ tenantId: TENANT_A }, () => prisma.conversation.findMany());
  check(
    "a plain findMany never returns another tenant's rows",
    !all.some((c) => c.title?.includes(TENANT_B)),
  );

  console.log('\n[2] Fail-closed without a scope');
  let threw = false;
  try {
    await prisma.conversation.findMany();
  } catch (error) {
    threw = error instanceof TenantScopeError;
    if (!threw) console.error('       (threw:', (error as Error).message, ')');
  }
  check('unscoped read throws TenantScopeError instead of leaking', threw);

  let crossWrite = false;
  try {
    await runWithTenant({ tenantId: TENANT_A }, () =>
      prisma.conversation.create({
        data: { tenantId: TENANT_B, title: 'cross-tenant write' } as never,
      }),
    );
  } catch (error) {
    crossWrite = error instanceof TenantScopeError;
  }
  check('a create naming a foreign tenantId is rejected', crossWrite);

  console.log('\n[3] Read-your-own scoping on the raw (unscoped) client');
  const raw = createRawPrismaClient({ connectionString: process.env.DIRECT_DATABASE_URL });
  openClients.push(raw);
  const everything = await raw.conversation.findMany();
  check(
    'the unscoped client does return both tenants (it is the escape hatch)',
    everything.length >= 2,
    `got ${everything.length}`,
  );

  console.log('\n[3b] Every tenant-owned table is registered, and nothing else is');
  // `TENANT_TABLE_REGISTRY` is the list other tooling consults before trusting a
  // table to be tenant-scoped. It is a hand-maintained list of *table* names, so it
  // cannot be derived from the schema the way `TENANT_SCOPED_MODELS` is — and a
  // hand-maintained list is exactly the kind that goes stale. So it is checked
  // against the catalog, in both directions, because the two mistakes are different
  // and both matter:
  //
  //   registered but unprotected — callers would rely on a policy that is not there
  //   protected but unregistered — a new table with a tenant_id column and a policy
  //                               would be invisible to whatever runs next
  //
  // The lookup is "has a `tenant_id` column", which is the real definition of
  // holding tenant data. Tables that deliberately opt out of RLS are handled by
  // naming them below rather than by letting them pass unnoticed.
  const tenantTables = await raw.$queryRaw<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
    ORDER BY table_name
  `;
  const policies = await raw.$queryRaw<{ tablename: string }[]>`
    SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
  `;
  const rlsProtected = new Set(policies.map((row) => row.tablename));

  const protectedButUnregistered = tenantTables
    .map((row) => row.table_name)
    .filter((name) => rlsProtected.has(name) && !TENANT_TABLE_REGISTRY.has(name));
  check(
    `every RLS-protected tenant table (${rlsProtected.size}) is in TENANT_TABLE_REGISTRY`,
    protectedButUnregistered.length === 0,
    `unregistered: ${protectedButUnregistered.join(', ')}`,
  );

  const registeredButUnprotected = [...TENANT_TABLE_REGISTRY].filter(
    (name) => !rlsProtected.has(name),
  );
  check(
    'no table is registered as tenant-scoped without a policy that makes it so',
    registeredButUnprotected.length === 0,
    `registered but unprotected: ${registeredButUnprotected.join(', ')}`,
  );

  // `refresh_tokens` carries a tenant_id for attribution but is deliberately not
  // RLS-protected: rotation has to resolve the token by hash before a tenant is
  // known (see rls.sql). It is in neither set above, which is correct — but "correct
  // by omission" is not a decision, it is an oversight that happens to be harmless.
  // Naming it here makes the exemption something someone chose.
  const deliberatelyUnprotected = tenantTables
    .map((row) => row.table_name)
    .filter((name) => !rlsProtected.has(name) && !TENANT_TABLE_REGISTRY.has(name));
  check(
    'the only tenant_id table opting out of RLS is refresh_tokens, by design',
    deliberatelyUnprotected.length === 1 && deliberatelyUnprotected[0] === 'refresh_tokens',
    `opted out: ${deliberatelyUnprotected.join(', ') || '(none)'}`,
  );

  console.log('\n[4] PostgreSQL Row Level Security — enforced, not assumed');
  // RLS is not enforced for a table owner and is always bypassed by a
  // superuser. The migration role is both, so this section deliberately runs
  // against a *separate* application role that owns nothing. Section 4a proves
  // that role really is unprivileged, because a check that silently connected
  // as the owner would pass while proving nothing.
  const appUrl = process.env.APP_DATABASE_URL;
  if (!appUrl) {
    check('APP_DATABASE_URL is set (see .env.example)', false);
  } else if (databaseNameOf(appUrl) !== databaseNameOf(process.env.DIRECT_DATABASE_URL)) {
    // Sections 1-3 create rows through the owner connection while section 4
    // reads them through the application role. If those point at different
    // databases, every row-visibility check below returns empty — which reads
    // like an RLS failure rather than a misconfigured test.
    check(
      'APP_DATABASE_URL and DIRECT_DATABASE_URL name the same database',
      false,
      `app=${databaseNameOf(appUrl)} owner=${databaseNameOf(process.env.DIRECT_DATABASE_URL)}`,
    );
  } else {
    const app = createRawPrismaClient({ connectionString: appUrl });
    const prismaApp = createPrismaClient({ connectionString: appUrl });
    openClients.push(app, prismaApp);

    console.log('\n[4a] The application role is genuinely unprivileged');
    const [who] = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT current_user                                        AS current_user,
             (SELECT rolsuper   FROM pg_roles WHERE rolname = current_user) AS is_superuser,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
             current_setting('row_security')                     AS row_security
    `;
    check('the app role is not a superuser', who?.is_superuser === false, JSON.stringify(who));
    check('the app role does not have BYPASSRLS', who?.bypasses_rls === false, JSON.stringify(who));
    check('row_security is on for this session', who?.row_security === 'on', JSON.stringify(who));

    const owned = await app.$queryRaw<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = current_user
    `;
    check(
      'the app role owns no tables (so RLS applies)',
      owned[0]?.n === '0',
      JSON.stringify(owned),
    );

    console.log('\n[4b] Row visibility is enforced by the database');
    // No tenant filter in the SQL: whatever rows come back were filtered by the
    // policy, which is the property being tested.
    const visibleAs = async (tenantId: string | null) =>
      app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SELECT set_config($1, $2, true)',
          'app.tenant_id',
          tenantId ?? '',
        );
        return tx.$queryRaw<{ title: string }[]>`
          SELECT title FROM conversations
        `;
      });

    const seenByA = await visibleAs(TENANT_A);
    const seenByB = await visibleAs(TENANT_B);
    const seenByNone = await visibleAs(null);

    check(
      "scoped as tenant A, an unfiltered SELECT returns only A's row",
      seenByA.length === 1 && seenByA[0]?.title === `owned by ${TENANT_A}`,
      JSON.stringify(seenByA),
    );
    check(
      "scoped as tenant B, an unfiltered SELECT returns only B's row",
      seenByB.length === 1 && seenByB[0]?.title === `owned by ${TENANT_B}`,
      JSON.stringify(seenByB),
    );
    check(
      'with no tenant set, an unfiltered SELECT returns zero rows (fail closed)',
      seenByNone.length === 0,
      JSON.stringify(seenByNone),
    );

    console.log('\n[4c] Cross-tenant writes are rejected by WITH CHECK');
    let writeBlocked = false;
    try {
      await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', TENANT_A);
        // Scoped as A, but claiming to write a row owned by B.
        await tx.$executeRawUnsafe(
          'INSERT INTO conversations (id, tenant_id, title, updated_at) VALUES ($1, $2, $3, now())',
          randomUUID(),
          TENANT_B,
          'cross-tenant write attempt',
        );
      });
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      const message = String((error as Error).message);
      writeBlocked = code === '42501' || /row-level security/i.test(message);
      if (!writeBlocked) {
        console.error('       (rejected for the wrong reason:', code, message.split('\n')[0], ')');
      }
    }
    check('inserting a row owned by another tenant is refused', writeBlocked);

    console.log('\n[4d] Tenant resolution still works under enforcement');
    // This is the chicken-and-egg case the SECURITY DEFINER function exists for:
    // reading `tenants` before any tenant is in scope returns nothing.
    const resolved = await app.$queryRaw<{ id: string; slug: string }[]>`
      SELECT id::text, slug FROM app_resolve_tenant(${`verify-${TENANT_A.slice(0, 8)}`})
    `;
    check(
      'app_resolve_tenant() finds the tenant before a scope exists',
      resolved.length === 1 && resolved[0]?.id === TENANT_A,
      JSON.stringify(resolved),
    );

    let resolutionRevoked = false;
    try {
      // The app role must not be able to enumerate tenants by reading the table.
      await app.$queryRawUnsafe('SELECT id FROM tenants');
    } catch {
      resolutionRevoked = true;
    }
    check(
      'a direct table read cannot bypass resolution (returns no rows, not an error)',
      !resolutionRevoked,
    );

    console.log('\n[4e] An unpinned query fails loudly instead of returning nothing');
    // The worst failure mode in this design: on an RLS-enforced connection a
    // query outside a pinned transaction comes back EMPTY, not wrong, and
    // "the list is empty" is a bug that ships. setRlsEnforcement() makes the
    // extension refuse instead, so the mistake surfaces at the call site.
    setRlsEnforcement(true);
    let refusal: unknown;
    try {
      await runWithTenant({ tenantId: TENANT_A }, () => prismaApp.conversation.findMany());
    } catch (error) {
      refusal = error;
    } finally {
      setRlsEnforcement(false);
    }
    check(
      'an unpinned tenant query throws rather than silently returning zero rows',
      refusal instanceof TenantTransactionRequiredError,
      refusal instanceof Error ? `got ${refusal.message}` : 'got no error',
    );

    const inPinnedTx = await app.$transaction(async (tx) => {
      await setRlsTenant(tx, TENANT_A);
      return runWithTenant({ tenantId: TENANT_A, rlsPinned: true }, () =>
        tx.conversation.findMany(),
      );
    });
    check(
      "the same query inside a pinned transaction returns the tenant's row",
      inPinnedTx.length === 1,
      `got ${inPinnedTx.length}`,
    );

    console.log('\n[4f] Control: the owner role bypasses RLS (proves the test discriminates)');
    // If this returned 0 rows too, the checks above would not be distinguishing
    // enforcement from an empty table.
    const seenByOwner = await raw.$queryRaw<{ title: string }[]>`
      SELECT title FROM conversations
    `;
    check(
      "the migration role sees every tenant's rows, so the tests above are meaningful",
      seenByOwner.length >= 2,
      `got ${seenByOwner.length}`,
    );

    console.log('\n[4g] Approval tokens are capabilities, scoped structurally');
    // The claim under test: presenting another tenant's approval token yields *no
    // row*, rather than a row that a comparison later refuses. That is what makes
    // the endpoint impossible to use as an oracle for probing which tenant a token
    // belongs to, and it is why `ApprovalService` contains no cross-tenant branch.
    for (const tenantId of [TENANT_A, TENANT_B]) {
      // Through the scoped client, with no tenantId in the payload. That it does not
      // throw is itself part of what section [0] checks: `ApprovalRequest` has to be
      // classified as tenant-scoped, or the extension would have thrown here.
      await runWithTenant({ tenantId }, async () => {
        await prisma.approvalRequest.create({
          data: {
            tokenHash: tokenHashFor(tenantId),
            jobId: gatedJobIds.get(tenantId),
            payload: {} as Prisma.InputJsonValue,
            requestedByUserId: randomUUID(),
            status: 'PENDING',
            expiresAt: new Date(Date.now() + 3_600_000),
          } as never,
        });
      });
    }

    // Resolved by hash, which is exactly how the service does it: no tenantId in the
    // predicate, so whatever comes back was decided by the policy.
    const approvalVisibleTo = (tenantId: string | null, tokenFor: string) =>
      app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SELECT set_config($1, $2, true)',
          'app.tenant_id',
          tenantId ?? '',
        );
        return tx.$queryRaw<{ id: string }[]>`
          SELECT id::text FROM approval_requests WHERE token_hash = ${tokenHashFor(tokenFor)}
        `;
      });

    check(
      'a tenant resolves its own approval token by hash, with no tenant filter in the query',
      (await approvalVisibleTo(TENANT_A, TENANT_A)).length === 1,
    );
    check(
      "another tenant's approval token resolves to nothing at all",
      (await approvalVisibleTo(TENANT_A, TENANT_B)).length === 0,
      'a visible-then-rejected row would make this endpoint an oracle',
    );
    check(
      'with no tenant pinned, an approval lookup returns nothing (fail closed)',
      (await approvalVisibleTo(null, TENANT_A)).length === 0,
    );

    // The same for the write path. Both outcomes count as blocked: a policy that
    // filters the row away reports zero matched rows, while one that treats the
    // statement as an attack aborts with 42501. What must never happen is a silent
    // success, so only that is a failure.
    let crossTenantApprovalWrite: 'matched-nothing' | 'refused' | 'succeeded';
    try {
      const matched = await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', TENANT_A);
        // Scoped as A, but aiming at B's row.
        return tx.$executeRawUnsafe(
          "UPDATE approval_requests SET status = 'APPROVED' WHERE token_hash = $1",
          tokenHashFor(TENANT_B),
        );
      });
      crossTenantApprovalWrite = matched === 0 ? 'matched-nothing' : 'succeeded';
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      const message = String((error as Error).message);
      crossTenantApprovalWrite =
        code === '42501' || /row-level security/i.test(message) ? 'refused' : 'succeeded';
      if (crossTenantApprovalWrite === 'succeeded') {
        console.error('       (rejected for the wrong reason:', code, message.split('\n')[0], ')');
      }
    }
    check(
      "updating another tenant's approval changes nothing",
      crossTenantApprovalWrite !== 'succeeded',
      `outcome: ${crossTenantApprovalWrite}`,
    );

    // The atomic claim, proven where it actually runs: the same `UPDATE ... AND status
    // = 'PENDING'` that `ApprovalService.recordDecision` issues, twice. The second
    // must match nothing, or a double-clicked link decides twice.
    const claimCount = async (tokenFor: string): Promise<number> => {
      try {
        return await app.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.tenant_id', TENANT_A);
          return tx.$executeRawUnsafe(
            "UPDATE approval_requests SET status = 'APPROVED', decided_at = now() WHERE token_hash = $1 AND status = 'PENDING'",
            tokenHashFor(tokenFor),
          );
        });
      } catch (error) {
        // Distinguish "matched nothing" from "the statement failed", which would make
        // the replay check below pass for the wrong reason.
        const message = String((error as Error).message);
        if (!/row-level security/i.test(message)) throw error;
        return 0;
      }
    };
    const firstClaim = await claimCount(TENANT_A);
    const secondClaim = await claimCount(TENANT_A);
    check(
      'the first claim on a pending approval matches one row',
      firstClaim === 1,
      `got ${firstClaim}`,
    );
    check(
      'a replayed claim on the same approval matches zero rows',
      secondClaim === 0,
      `got ${secondClaim}`,
    );
  }
}

/**
 * Removes everything this run created and closes every connection.
 *
 * In a `finally`, because failing is this script's normal mode and a failed run that
 * leaves two tenants and their rows behind makes the *next* run's output confusing —
 * or, worse, makes a later `db:verify` look like it is reading someone else's data.
 * The seeded tenants cascade to their jobs and approvals.
 */
async function cleanup(): Promise<void> {
  console.log('\n[5] Cleanup');
  try {
    await ownerClient.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    console.log('  done');
  } catch (error) {
    console.error(`  could not remove the seeded tenants: ${(error as Error).message}`);
    console.error(`  delete them by hand: WHERE id IN ('${TENANT_A}', '${TENANT_B}')`);
  }
  await Promise.allSettled([
    ...openClients.map((client) => client.$disconnect()),
    ownerClient.$disconnect(),
  ]);
}

try {
  await main();
} finally {
  await cleanup();
  // Printed last, so the summary is the final thing on screen and a cleanup failure
  // cannot scroll it out of view.
  console.log(
    `\n${failures === 0 ? 'ALL GREEN' : 'FAILURES'}: ${checks - failures}/${checks} checks passed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
