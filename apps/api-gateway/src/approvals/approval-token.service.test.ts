/**
 * Approval token generation and hashing.
 *
 * These tests are about the properties the rest of the module relies on rather
 * than about a specific byte string: the token must be the right length and
 * alphabet to sit in a URL path, it must not repeat, and the hash must be a
 * stable one-way function of it.
 *
 * The last one is the important one. `hashApprovalToken` is the join between a
 * token in a URL and a row in Postgres, and it is not the service's own choice —
 * a seeder, a fixture or a future reconciliation script has to produce the same
 * hash. Pinning the value below is what makes a change to that function a test
 * failure rather than a field of silently-unmatched approval links.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TOKEN_LENGTH,
  ApprovalTokenService,
  hashApprovalToken,
  looksLikeApprovalToken,
} from './approval-token.service.js';

const service = new ApprovalTokenService();

describe('ApprovalTokenService.issue', () => {
  it('produces a token that passes its own shape check', () => {
    const { token } = service.issue();
    expect(looksLikeApprovalToken(token)).toBe(true);
  });

  it('produces exactly 256 bits of entropy in 43 base64url characters', () => {
    const { token } = service.issue();
    expect(token).toHaveLength(APPROVAL_TOKEN_LENGTH);
    // 43 chars of base64url = 43 * 6 = 258 bits of alphabet, of which 256 are
    // payload and 2 are padding that base64url does not emit. Asserted rather
    // than assumed: a shortened token is still "random-looking" and would pass
    // any test that only checked for uniqueness.
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats across many draws', () => {
    // 2048 draws is far more than enough to catch a `Math.random()` stand-in or a
    // counter, and cheap enough to run on every commit.
    const seen = new Set<string>();
    for (let index = 0; index < 2_048; index += 1) {
      seen.add(service.issue().token);
    }
    expect(seen.size).toBe(2_048);
  });

  it('returns the hash of the token it just issued', () => {
    const { token, tokenHash } = service.issue();
    expect(tokenHash).toBe(hashApprovalToken(token));
    expect(service.hash(token)).toBe(tokenHash);
  });
});

describe('hashApprovalToken', () => {
  it('is the documented sha256 hex of the token', () => {
    // Pinned rather than recomputed with the same function under test: a test
    // that calls `createHash('sha256')` to check `hashApprovalToken` is a test of
    // `createHash`. This value is the contract with every row already written.
    expect(hashApprovalToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is 64 hex characters, matching the CHAR(64) column', () => {
    expect(hashApprovalToken(service.issue().token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes tokens differing in one character', () => {
    const a = hashApprovalToken('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const b = hashApprovalToken('BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(a).not.toBe(b);
  });

  it('is lowercase, because the column is CHAR(64) and compared case-sensitively', () => {
    // A digest containing an uppercase character would silently never match if a
    // future implementation switched to `.toUpperCase()` for display purposes.
    expect(hashApprovalToken('MiXeD')).toBe(hashApprovalToken('MiXeD').toLowerCase());
  });
});

describe('looksLikeApprovalToken', () => {
  it('accepts a real token', () => {
    expect(looksLikeApprovalToken(service.issue().token)).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(looksLikeApprovalToken('')).toBe(false);
    expect(looksLikeApprovalToken('abc')).toBe(false);
    expect(looksLikeApprovalToken('a'.repeat(APPROVAL_TOKEN_LENGTH + 1))).toBe(false);
  });

  it('rejects characters outside the base64url alphabet', () => {
    // `/`, `.` and whitespace are all outside base64url, and all three would
    // either break the single path segment or invite a caller to hand us
    // something that is not a token at all. Refused before a database round trip,
    // since this guard runs on a public endpoint.
    const filler = 'a'.repeat(APPROVAL_TOKEN_LENGTH - 2);
    for (const bad of [`${filler}.x`, `${filler}/x`, `${filler} x`, `+${filler}`]) {
      expect(looksLikeApprovalToken(bad)).toBe(false);
    }
  });

  it('accepts the two punctuation characters base64url does use', () => {
    // Asserted so the test above is not mistaken for "reject anything that is not
    // alphanumeric": `-` and `_` are the entire reason base64url exists, and a
    // token containing them is perfectly well formed.
    const body = 'a'.repeat(APPROVAL_TOKEN_LENGTH - 2);
    expect(looksLikeApprovalToken(`-${body}-`)).toBe(true);
    expect(looksLikeApprovalToken(`_${body}_`)).toBe(true);
  });

  it('rejects non-ASCII that would be multi-byte in a URL', () => {
    expect(looksLikeApprovalToken('é'.repeat(APPROVAL_TOKEN_LENGTH))).toBe(false);
  });
});

describe('the token is not recoverable from the hash', () => {
  it('does not appear in the digest or its hex bytes', () => {
    const { token, tokenHash } = service.issue();
    expect(tokenHash).not.toContain(token);
    // The raw digest bytes must not contain the token's bytes either, which a
    // base64 string check alone would not catch.
    const digest = Buffer.from(tokenHash, 'hex');
    expect(digest.includes(Buffer.from(token, 'utf8'))).toBe(false);
  });

  it('is verified by re-hashing rather than by comparing the token', () => {
    // Documents the shape of verification for the next reader: the token is a
    // lookup key, so the "comparison" is an index match inside Postgres and
    // there is no constant-time string comparison anywhere in this path.
    const { token, tokenHash } = service.issue();
    expect({ where: { tokenHash: hashApprovalToken(token) } }.where.tokenHash).toBe(tokenHash);
  });
});
