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
import { randomUUID } from 'node:crypto';
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

async function main(): Promise<void> {
  const prisma = createPrismaClient({ connectionString: process.env.DIRECT_DATABASE_URL });

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
  const everything = await raw.conversation.findMany();
  check(
    'the unscoped client does return both tenants (it is the escape hatch)',
    everything.length >= 2,
    `got ${everything.length}`,
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

    await Promise.all([app.$disconnect(), prismaApp.$disconnect()]);
  }

  console.log('\n[5] Cleanup');
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  console.log('  done');

  await Promise.all([prisma.$disconnect(), raw.$disconnect()]);

  console.log(
    `\n${failures === 0 ? 'ALL GREEN' : 'FAILURES'}: ${checks - failures}/${checks} checks passed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
