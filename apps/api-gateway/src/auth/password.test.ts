/**
 * Password hashing tests.
 *
 * The expensive parameters are reduced for most cases: scrypt at N=16384 takes
 * ~70ms, and a suite that spends two seconds hashing would be a suite people
 * start skipping. The cases that must run at the real default are marked, because
 * the thing they prove — that the format matches what `seed.ts` writes — is the
 * single most important compatibility claim in this module.
 */
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  inspectPasswordHash,
  parseHash,
  verifyPassword,
  type ScryptCost,
} from './password.js';

/** Fast parameters, still real scrypt. */
const FAST: ScryptCost = { N: 1024, r: 8, p: 1 };
/** What `seed.ts` and the production default both use. */
const PRODUCTION: ScryptCost = { N: 16384, r: 8, p: 1 };

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('Correct horse battery staple', stored)).resolves.toBe(false);
  });

  it('is case sensitive, as a password must be', async () => {
    const stored = await hashPassword('Passw0rd', FAST);
    await expect(verifyPassword('passw0rd', stored)).resolves.toBe(false);
  });

  it('salts every hash, so identical passwords differ', async () => {
    // Without a per-password salt, two users who choose the same password share
    // a digest, and one cracked hash cracks both.
    const [a, b] = await Promise.all([
      hashPassword('same-password', FAST),
      hashPassword('same-password', FAST),
    ]);
    expect(a).not.toBe(b);

    await expect(verifyPassword('same-password', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });

  it('stores the parameters in the hash', async () => {
    const stored = await hashPassword('anything', { N: 2048, r: 4, p: 2 });
    const parsed = parseHash(stored);

    expect(parsed).not.toBeNull();
    expect(parsed?.algorithm).toBe('scrypt');
    // Raising the cost later must not invalidate this row, so the cost has to
    // travel with it.
    expect(parsed?.N).toBe(2048);
    expect(parsed?.r).toBe(4);
    expect(parsed?.p).toBe(2);
  });

  it('verifies at the stored cost, not the current one', async () => {
    // A password hashed when N was small must still verify after the policy is
    // raised — otherwise the raise logs out every existing user.
    const stored = await hashPassword('legacy-password', { N: 256, r: 8, p: 1 });
    await expect(verifyPassword('legacy-password', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false);
  });

  it('normalises Unicode so equivalent passwords match', async () => {
    // Written with explicit escapes because the two forms are indistinguishable
    // in a source file, and a literal "é" would silently normalise to whichever
    // form the editor happened to save — making the test assert nothing.
    // U+00E9 is é precomposed; U+0065 U+0301 is "e" plus a combining acute.
    const composed = 'caf\u00e9-secret';
    const decomposed = 'cafe\u0301-secret';

    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFKC')).toBe(decomposed.normalize('NFKC'));

    const stored = await hashPassword(composed, FAST);
    await expect(verifyPassword(decomposed, stored)).resolves.toBe(true);
  });

  it('verifies a hash produced by prisma/seed.ts', async () => {
    // The compatibility claim that matters. `packages/database/prisma/seed.ts`
    // hashes with `scrypt$16384$8$1$<salt>$<hash>` and the documented demo
    // credentials are `owner@acme.test` / `Password123!`. If this fails, the
    // seeded user cannot sign in and every quick start in the README breaks.
    //
    // The literal below was produced by seed.ts's own code path, not by
    // `hashPassword` — that is the point. It is a positive assertion, so the
    // test fails if parsing, NFKC normalisation, the cost parameters or the
    // 64-byte key length drift.
    const seededBySeedScript =
      'scrypt$16384$8$1$GvaIDFtqv50Ozr9NQ/CgxA==$' +
      'eBx4lloSXUV8mLbbuEzK8lhrmOLhi/RuBR24+y2iAYQzp29nU1T2C3owEPgY2f9Mmz7qzE972E7hKFNYmsAWGw==';

    expect(parseHash(seededBySeedScript)).not.toBeNull();
    await expect(verifyPassword('Password123!', seededBySeedScript)).resolves.toBe(true);
    await expect(verifyPassword('password123!', seededBySeedScript)).resolves.toBe(false);
  });
});

describe('verifyPassword on malformed input', () => {
  const malformed: readonly [string, string][] = [
    ['an empty string', ''],
    ['too few fields', 'scrypt$16384$8$1$onlysalt'],
    ['too many fields', 'scrypt$1$2$3$4$5$6$extra'],
    ['an unknown algorithm', 'bcrypt$16384$8$1$c2FsdA$aGFzaA'],
    ['non-numeric cost', 'scrypt$abc$8$1$c2FsdA$aGFzaA'],
    ['zero cost', 'scrypt$0$8$1$c2FsdA$aGFzaA'],
    ['a negative cost', 'scrypt$-16384$8$1$c2FsdA$aGFzaA'],
    ['an absent salt', 'scrypt$16384$8$1$$aGFzaA'],
    ['an absurd N that would exhaust memory', `scrypt$${2 ** 30}$8$1$c2FsdA$aGFzaA`],
    ['an absurd r', 'scrypt$16384$999$1$c2FsdA$aGFzaA'],
  ];

  for (const [label, stored] of malformed) {
    it(`returns false for ${label}`, async () => {
      // Returning false rather than throwing keeps a corrupt row from turning
      // into a 500 on the sign-in path.
      await expect(verifyPassword('any-password', stored)).resolves.toBe(false);
      expect(parseHash(stored)).toBeNull();
    });
  }

  it('returns false when the stored hash has the wrong byte length', async () => {
    // timingSafeEqual throws on a length mismatch, so the guard has to come first.
    const stored = `scrypt$1024$8$1$${Buffer.from('salt').toString('base64')}$${Buffer.from('short').toString('base64')}`;
    await expect(verifyPassword('any-password', stored)).resolves.toBe(false);
  });
});

describe('inspectPasswordHash', () => {
  it('reports no rehash need when the cost already matches', async () => {
    const stored = await hashPassword('password', FAST);
    expect(inspectPasswordHash(stored, FAST)).toEqual({
      valid: true,
      algorithm: 'scrypt',
      cost: FAST,
      needsRehash: false,
    });
  });

  it('flags a hash below the current cost', async () => {
    // This is what makes it safe to raise AUTH_SCRYPT_N: existing rows are
    // upgraded at the next sign-in rather than being invalidated.
    const stored = await hashPassword('password', FAST);
    const info = inspectPasswordHash(stored, PRODUCTION);

    expect(info.needsRehash).toBe(true);
    expect(info.cost).toEqual(FAST);
  });

  it('does not flag a hash above the current cost', async () => {
    const stored = await hashPassword('password', PRODUCTION);
    expect(inspectPasswordHash(stored, FAST).needsRehash).toBe(false);
  });

  it('reports an unparseable hash as invalid rather than throwing', () => {
    expect(inspectPasswordHash('garbage')).toEqual({
      valid: false,
      algorithm: null,
      cost: null,
      needsRehash: false,
    });
  });
});

describe('production cost', () => {
  it('hashes and verifies at the default parameters', async () => {
    // The one place that deliberately uses the real cost: the format, the
    // 64-byte key length and the timing envelope all have to hold at the values
    // that actually run in production.
    const stored = await hashPassword('production-cost-password', PRODUCTION);

    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(parseHash(stored)).not.toBeNull();
    await expect(verifyPassword('production-cost-password', stored)).resolves.toBe(true);
    await expect(verifyPassword('not-it', stored)).resolves.toBe(false);
  });
});
