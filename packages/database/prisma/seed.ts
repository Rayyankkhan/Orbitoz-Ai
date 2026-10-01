/**
 * Development seed.
 *
 *   pnpm db:seed        (or)   pnpm --filter @orbitoz/database seed
 *
 * Idempotent: every insert is an upsert keyed on a natural unique column, so
 * re-running converges rather than duplicating. Safe to run against a database
 * that already has real data.
 *
 * CONNECTION
 *   Uses DIRECT_DATABASE_URL (the migration role), never DATABASE_URL. The seed
 *   writes `provider_models`, which has a SELECT-only RLS policy for the
 *   application role — the catalogue is admin data, seeded by the owner, read by
 *   every tenant. It also creates tenants, which is the platform-level
 *   provisioning path, not a tenant-scoped one.
 *
 * CREDENTIALS
 *   The demo password is printed below and is intentionally weak. It is for a
 *   local database that holds nothing of value; do not carry it anywhere near a
 *   shared environment.
 */
import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
// Imported from the factory module, not the package barrel. The barrel also
// re-exports PrismaService, which carries Nest decorators; this script runs
// through tsx, and esbuild cannot transform decorator syntax. Reaching past the
// barrel keeps the seed free of a Nest dependency it has no use for.
import { createRawPrismaClient } from '../src/client/prisma-factory.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
 *
 * The verification side must parse this exact layout — see
 * docs/architecture/authentication.md. scrypt is used here because it is built
 * into Node with no native dependency to compile; production should prefer
 * argon2id where a native module is acceptable, and changing this format means
 * re-hashing on next sign-in.
 */
async function hashPassword(password: string): Promise<string> {
  const N = 16384;
  const r = 8;
  const p = 1;
  const keylen = 64;
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, keylen);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// The upstream model catalogue.
//
// Costs are USD per 1M tokens as integers with 4 decimal places, so 25000 means
// $2.50. Using integers rather than floats keeps billing arithmetic exact —
// summing 0.1 ten times in floating point does not give 1.0.
// ---------------------------------------------------------------------------
const CATALOGUE = [
  {
    provider: 'openai',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    capabilities: ['chat', 'vision', 'tools', 'json_mode'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerMTokens: 25_000, // $2.50
    outputCostPerMTokens: 100_000, // $10.00
    qualityScore: 8_800,
    latencyScore: 7_200,
  },
  {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    capabilities: ['chat', 'vision', 'tools', 'json_mode'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerMTokens: 1_500, // $0.15
    outputCostPerMTokens: 6_000, // $0.60
    qualityScore: 7_600,
    latencyScore: 9_000,
  },
  {
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    displayName: 'Text Embedding 3 Small',
    capabilities: ['embeddings'],
    contextWindow: 8_191,
    maxOutputTokens: null,
    inputCostPerMTokens: 200, // $0.02
    outputCostPerMTokens: 0,
    qualityScore: 6_500,
    latencyScore: 9_500,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    capabilities: ['chat', 'vision', 'tools', 'json_mode'],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPerMTokens: 30_000, // $3.00
    outputCostPerMTokens: 150_000, // $15.00
    qualityScore: 9_200,
    latencyScore: 7_800,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    capabilities: ['chat', 'tools'],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPerMTokens: 10_000, // $1.00
    outputCostPerMTokens: 50_000, // $5.00
    qualityScore: 8_000,
    latencyScore: 9_200,
  },
  {
    provider: 'google',
    modelId: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    capabilities: ['chat', 'vision', 'tools'],
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    inputCostPerMTokens: 1_000, // $0.10
    outputCostPerMTokens: 4_000, // $0.40
    qualityScore: 7_000,
    latencyScore: 9_000,
  },
  {
    provider: 'mistral',
    modelId: 'mistral-large-latest',
    displayName: 'Mistral Large',
    capabilities: ['chat', 'tools', 'json_mode'],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPerMTokens: 20_000, // $2.00
    outputCostPerMTokens: 60_000, // $6.00
    qualityScore: 7_400,
    latencyScore: 7_000,
  },
  {
    provider: 'local',
    modelId: 'llama-3.3-70b',
    displayName: 'Llama 3.3 70B (self-hosted)',
    capabilities: ['chat', 'tools'],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    // Self-hosted: no per-token charge, only the compute the tenant already pays
    // for. Zero is a real value here, not "unknown".
    inputCostPerMTokens: 0,
    outputCostPerMTokens: 0,
    qualityScore: 6_800,
    latencyScore: 5_500,
  },
] as const;

const DEMO_TENANT_SLUG = 'acme';
const DEMO_USER_EMAIL = 'owner@acme.test';
const DEMO_PASSWORD = 'Password123!';

async function main(): Promise<void> {
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    throw new Error('DIRECT_DATABASE_URL is not set; the seed runs as the migration role.');
  }
  const prisma = createRawPrismaClient({ connectionString });

  try {
    console.log('Seeding provider model catalogue…');
    const modelIds = new Map<string, string>();
    for (const model of CATALOGUE) {
      const row = await prisma.providerModel.upsert({
        where: { provider_modelId: { provider: model.provider, modelId: model.modelId } },
        update: {
          displayName: model.displayName,
          capabilities: [...model.capabilities],
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          inputCostPerMTokens: model.inputCostPerMTokens,
          outputCostPerMTokens: model.outputCostPerMTokens,
          qualityScore: model.qualityScore,
          latencyScore: model.latencyScore,
          isEnabled: true,
        },
        create: { ...model, capabilities: [...model.capabilities] },
        select: { id: true },
      });
      modelIds.set(`${model.provider}/${model.modelId}`, row.id);
    }
    console.log(`  ${CATALOGUE.length} models`);

    console.log('Seeding demo tenant, owner and subscription…');
    const tenant = await prisma.tenant.upsert({
      where: { slug: DEMO_TENANT_SLUG },
      update: { name: 'Acme Corp' },
      create: {
        slug: DEMO_TENANT_SLUG,
        name: 'Acme Corp',
        // 14-day trial, matching the default TRIALING status.
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000),
        monthlyRequestQuota: 100_000,
        maxSeats: 25,
        maxRpm: 120,
      },
      select: { id: true },
    });

    // The email is the natural key. A real deployment would have a dedicated
    // email-verification service; the seed marks the user verified so the demo
    // tenant can sign in without a mail round-trip (Mailpit is on localhost:8025).
    const user = await prisma.user.upsert({
      where: { email: DEMO_USER_EMAIL },
      update: { name: 'Ada Lovelace' },
      create: {
        email: DEMO_USER_EMAIL,
        name: 'Ada Lovelace',
        passwordHash: await hashPassword(DEMO_PASSWORD),
        emailVerifiedAt: new Date(),
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      update: { role: 'OWNER' },
      create: { tenantId: tenant.id, userId: user.id, role: 'OWNER' },
    });

    await prisma.subscription.upsert({
      where: { tenantId: tenant.id },
      update: { plan: 'GROWTH', status: 'TRIALING', seats: 5 },
      create: {
        tenantId: tenant.id,
        plan: 'GROWTH',
        status: 'TRIALING',
        seats: 5,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000),
      },
    });

    // Entitlements mirror the plan the subscription above implies.
    for (const key of ['openai/gpt-4o', 'anthropic/claude-sonnet-4-5', 'local/llama-3.3-70b']) {
      const modelId = modelIds.get(key);
      if (!modelId) continue;
      await prisma.tenantProvider.upsert({
        where: { tenantId_modelId: { tenantId: tenant.id, modelId } },
        update: { status: 'ENABLED' },
        create: { tenantId: tenant.id, modelId, status: 'ENABLED' },
      });
    }

    console.log('Seeding a demo API key…');
    // Only the hash is persisted; the plaintext is shown once, here.
    //
    // The prefix is fixed rather than derived from the secret. It is what makes
    // re-seeding idempotent: `deleteMany` has to be able to find the previous
    // run's key. A prefix taken from a random secret never matches, so the demo
    // tenant would gain a new key on every `pnpm db:seed` and the one printed by
    // the previous run would quietly stop working.
    const apiKeySecret = `of_live_${randomBytes(24).toString('base64url')}`;
    const DEMO_KEY_PREFIX = 'of_demo_000';
    await prisma.apiKey.deleteMany({ where: { tenantId: tenant.id, prefix: DEMO_KEY_PREFIX } });
    await prisma.apiKey.create({
      data: {
        tenantId: tenant.id,
        name: 'seeded development key',
        prefix: DEMO_KEY_PREFIX,
        secretHash: sha256(apiKeySecret),
        scopes: ['INFERENCE_READ', 'INFERENCE_WRITE', 'USAGE_READ'],
      },
    });

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  Demo tenant   https://acme.localhost:3000');
    console.log(`  Sign in       ${DEMO_USER_EMAIL}`);
    console.log(`  Password      ${DEMO_PASSWORD}`);
    console.log(`  API key       ${apiKeySecret}`);
    console.log('──────────────────────────────────────────────────────────────');
    console.log('\nThe API key is shown once and only its SHA-256 is stored.');
  } finally {
    await prisma.$disconnect();
  }
}

await main();
