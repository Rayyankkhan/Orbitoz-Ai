/**
 * Password hashing.
 *
 * Format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
 *
 * ---------------------------------------------------------------------------
 * WHY scrypt AND NOT bcrypt
 * ---------------------------------------------------------------------------
 * An earlier draft of this module called for bcrypt. scrypt is used instead for
 * two reasons that are not stylistic:
 *
 *   1. bcrypt is a native module. It needs a C toolchain or prebuilt binaries
 *      per platform, which is precisely the class of dependency a
 *      `emitDecoratorMetadata` + native-ESM workspace should not take on. scrypt
 *      is in `node:crypto`, so there is nothing to build.
 *   2. `packages/database/prisma/seed.ts` already writes `scrypt$N$r$p$…`. A
 *      bcrypt implementation would refuse every seeded credential, including the
 *      documented `owner@acme.test` / `Password123!` pair, because it could not
 *      parse the stored string. The parameters are recorded *in the hash*, so
 *      raising scrypt's cost later does not invalidate existing rows.
 *
 * scrypt is memory-hard, which is the property that matters against GPU
 * cracking; a SHA-256 or plain-SHA1 digest with a per-user salt does not have it.
 *
 * ---------------------------------------------------------------------------
 * WHY PARAMETERS TRAVEL WITH THE HASH
 * ---------------------------------------------------------------------------
 * Cost is not a constant here. It gets raised as hardware improves, and old rows
 * keep verifying at their original cost. Hard-coding one N in the verifier means
 * a future cost increase either invalidates every existing password (locking out
 * every user) or silently verifies new passwords at a weak cost. Storing the
 * parameters in the string makes both a non-issue.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

interface ScryptOptions {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Cost parameters for newly created hashes.
 *
 * N=16384 with r=8 needs 128 * N * r = 16 MiB and takes roughly 70ms on a
 * modern laptop core. That is a deliberate trade: high enough to make offline
 * cracking expensive, low enough that a login does not hold a request worker for
 * a noticeable fraction of a second. Both are configurable per environment via
 * `AUTH_SCRYPT_*`, because the right value depends entirely on the hardware the
 * gateway runs on.
 */
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

/**
 * Node refuses scrypt work needing more than 32 MiB by default, and the limit is
 * applied against the computed requirement. Scaled to 4x the memory the chosen
 * parameters need so a raised `N` fails loudly here rather than at the first
 * login attempt in production.
 */
function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 4;
}

/**
 * Hashes a password with a fresh random salt.
 *
 * NFKC-normalised before hashing. Without it, the same visual password typed on
 * two platforms with different Unicode composition rules produces different
 * hashes, and a user cannot sign in with the password they just set.
 */
export async function hashPassword(
  password: string,
  params: ScryptCost = DEFAULT_PARAMS,
): Promise<string> {
  const { N, r, p } = params;
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(normalize(password), salt, KEY_BYTES, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });

  return [ALGORITHM, N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export interface ScryptCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing for a malformed or unrecognised hash: a
 * corrupt row must not turn into a 500 on the sign-in path, and the caller
 * cannot act differently based on *why* verification failed anyway. Structural
 * problems are still distinguishable — see {@link inspectPasswordHash} — because
 * a stored hash that cannot be parsed is a bug worth alerting on, not a routine
 * "wrong password".
 *
 * Comparison is constant-time. `timingSafeEqual` on two equal-length buffers is
 * what stops an attacker from learning the digest a byte at a time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(normalize(password), parsed.salt, KEY_BYTES, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmemFor(parsed.N, parsed.r),
    });
  } catch {
    // Cost parameters outside what this machine allows. Treated as a failed
    // verification: refusing the login is safe, whereas crashing is a 500 that
    // looks like a gateway fault rather than a misconfiguration.
    return false;
  }

  const expected = Buffer.from(parsed.hash, 'base64');
  // timingSafeEqual throws on a length mismatch, and the derived length is
  // fixed at KEY_BYTES while `expected` length is whatever was stored. Compare
  // lengths first, then the bytes.
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export interface ParsedHash {
  readonly algorithm: typeof ALGORITHM;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: string;
}

export function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  // algo, N, r, p, salt, hash — six fields, no more.
  if (parts.length !== 6) return null;

  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hash] = parts;
  if (algorithm !== ALGORITHM || !nRaw || !rRaw || !pRaw || !saltRaw || !hash) return null;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  // Guard against absurd values before they reach scrypt: a stored N of 2**30
  // would attempt a multi-terabyte allocation. Rows are only ever written by
  // hashPassword, but a corrupted value must not be able to exhaust memory.
  if (!isPositiveInteger(N) || !isPositiveInteger(r) || !isPositiveInteger(p)) return null;
  if (N > 1 << 20 || r > 32 || p > 16) return null;

  const salt = Buffer.from(saltRaw, 'base64');
  const decoded = Buffer.from(hash, 'base64');
  if (salt.length === 0 || decoded.length === 0) return null;

  return { algorithm: ALGORITHM, N, r, p, salt, hash: decoded.toString('base64') };
}

export interface PasswordHashInfo {
  readonly valid: boolean;
  readonly algorithm: string | null;
  readonly cost: ScryptCost | null;
  /** True when the hash is well-formed but weaker than the current policy. */
  readonly needsRehash: boolean;
}

/**
 * Reports the strength of a stored hash.
 *
 * `needsRehash` exists so a sign-in can transparently upgrade a password hashed
 * under an older cost. Without it, raising `N` would leave every existing
 * account on the weak parameters until each user happened to change their
 * password — which is to say, indefinitely.
 */
export function inspectPasswordHash(
  stored: string,
  current: ScryptCost = DEFAULT_PARAMS,
): PasswordHashInfo {
  const parsed = parseHash(stored);
  if (!parsed) return { valid: false, algorithm: null, cost: null, needsRehash: false };

  const cost: ScryptCost = { N: parsed.N, r: parsed.r, p: parsed.p };
  return {
    valid: true,
    algorithm: parsed.algorithm,
    cost,
    needsRehash: parsed.N < current.N || parsed.r < current.r || parsed.p < current.p,
  };
}

function normalize(password: string): string {
  return password.normalize('NFKC');
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
