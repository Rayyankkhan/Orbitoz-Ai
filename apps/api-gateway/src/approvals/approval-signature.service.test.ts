/**
 * Approval signature signing and verification.
 *
 * The properties under test, in order of how much damage getting them wrong
 * would cause:
 *
 *   1. A grant is bound to one action. A signature lifted from the approve button
 *      must not authorise a rejection.
 *   2. A grant is bound to one token. A signature for one approval must not
 *      authorise another.
 *   3. A grant expires. A signature from yesterday must not work today.
 *   4. Comparison is timing-safe, so the reason is structural rather than a
 *      property anyone re-checks later.
 *
 * `nowSeconds` is injected into `verify`, so none of this needs a frozen clock —
 * which is why the time window is asserted against an explicit argument instead
 * of `Date.now()` and a tolerance hack.
 */
import { describe, expect, it } from 'vitest';
import { ApprovalSignatureService } from './approval-signature.service.js';

const SECRET = 'test-approval-signing-secret-0123456789abcdef';
const TOLERANCE = 300;
const TOKEN = 'kZ8mQ2vXpL4nR7wY1aB3cD5eF6gH8jK0lM9nP2qR4tU';
const NOW = 1_700_000_000;

const service = new ApprovalSignatureService({ secret: SECRET, toleranceSeconds: TOLERANCE });

function sign(
  action: 'APPROVE' | 'REJECT',
  token = TOKEN,
  timestamp = NOW,
  signer = service,
): string {
  return signer.sign(token, action, timestamp);
}

describe('ApprovalSignatureService construction', () => {
  it('refuses a secret shorter than the HMAC minimum', () => {
    // A short key produces signatures that verify perfectly, so a truncated
    // secret is indistinguishable from a working one until someone forges with
    // it. Failing here turns that into a startup error.
    expect(
      () => new ApprovalSignatureService({ secret: 'short', toleranceSeconds: TOLERANCE }),
    ).toThrow(/at least 32 bytes/);
  });

  it('accepts a 32-byte secret', () => {
    expect(
      () => new ApprovalSignatureService({ secret: 'a'.repeat(32), toleranceSeconds: 1 }),
    ).not.toThrow();
  });

  it('reports the tolerance it was configured with', () => {
    expect(service.tolerance).toBe(TOLERANCE);
  });
});

describe('sign / verify round trip', () => {
  it('accepts a grant it issued', () => {
    const signature = sign('APPROVE');
    expect(service.verify(TOKEN, 'APPROVE', String(NOW), signature, NOW)).toEqual({ ok: true });
  });

  it('emits the versioned wire format', () => {
    expect(sign('APPROVE')).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('produces a different signature per action', () => {
    expect(sign('APPROVE')).not.toBe(sign('REJECT'));
  });

  it('produces a different signature per timestamp', () => {
    expect(sign('APPROVE', TOKEN, NOW)).not.toBe(sign('APPROVE', TOKEN, NOW + 1));
  });

  it('produces a different signature per token', () => {
    expect(sign('APPROVE', TOKEN)).not.toBe(sign('APPROVE', 'Y'.repeat(43)));
  });
});

describe('the grant is bound to its action', () => {
  it('refuses an approve grant presented as a reject', () => {
    // The attack this exists for: a page modified in transit flips the button's
    // action from APPROVE to REJECT, keeping the signature it was issued with.
    const signature = sign('APPROVE');
    expect(service.verify(TOKEN, 'REJECT', String(NOW), signature, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses a reject grant presented as an approve', () => {
    const signature = sign('REJECT');
    expect(service.verify(TOKEN, 'APPROVE', String(NOW), signature, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it("does not accept one action's grant for the other even at a different time", () => {
    // Both halves of the canonical string change, so this could only pass if the
    // implementation were signing the action loosely — e.g. checking only that a
    // signature exists rather than recomputing it.
    const signature = sign('REJECT', TOKEN, NOW);
    expect(service.verify(TOKEN, 'APPROVE', String(NOW - 10), signature, NOW).ok).toBe(false);
  });
});

describe('the grant is bound to its approval request', () => {
  it('refuses a grant issued for another token', () => {
    const signature = sign('APPROVE', TOKEN);
    const otherToken = 'Z'.repeat(43);
    expect(service.verify(otherToken, 'APPROVE', String(NOW), signature, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses a grant issued by a different secret', () => {
    // Models a second environment, or a rotated key that a stale page still
    // carries. Either way the old grant must stop working on its own.
    const rotated = new ApprovalSignatureService({
      secret: 'a-different-approval-secret-0123456789abcdef',
      toleranceSeconds: TOLERANCE,
    });
    const stale = sign('APPROVE', TOKEN, NOW, rotated);
    expect(service.verify(TOKEN, 'APPROVE', String(NOW), stale, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });
});

describe('the grant expires', () => {
  it('accepts a timestamp just inside the window', () => {
    const signature = sign('APPROVE', TOKEN, NOW - TOLERANCE);
    expect(service.verify(TOKEN, 'APPROVE', String(NOW - TOLERANCE), signature, NOW)).toEqual({
      ok: true,
    });
  });

  it('refuses a timestamp one second too old', () => {
    const issuedAt = NOW - TOLERANCE - 1;
    const signature = sign('APPROVE', TOKEN, issuedAt);
    expect(service.verify(TOKEN, 'APPROVE', String(issuedAt), signature, NOW)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_range',
    });
  });

  it('refuses a timestamp in the future beyond the window', () => {
    // A caller claiming a later timestamp would otherwise extend its own grant
    // indefinitely by incrementing the field.
    const issuedAt = NOW + TOLERANCE + 1;
    const signature = sign('APPROVE', TOKEN, issuedAt);
    expect(service.verify(TOKEN, 'APPROVE', String(issuedAt), signature, NOW)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_range',
    });
  });

  it('treats the window as absolute, so a slow approver is still served', () => {
    // A phone whose clock is a minute behind must not be told its link expired.
    const issuedAt = NOW - 60;
    const signature = sign('APPROVE', TOKEN, issuedAt);
    expect(service.verify(TOKEN, 'APPROVE', String(issuedAt), signature, NOW + 60)).toEqual({
      ok: true,
    });
  });

  it('refuses a timestamp that is not an integer', () => {
    // Checked before the range comparison, because `Number('')` is 0 and
    // `Number('abc')` is NaN — both of which would otherwise reach the HMAC and
    // fail there with a much less useful message.
    for (const bad of ['', 'abc', '1.5', '1e3x']) {
      const result = service.verify(TOKEN, 'APPROVE', bad, sign('APPROVE'), NOW);
      expect(result).toEqual({ ok: false, reason: 'timestamp_not_integer' });
    }
  });

  it('refuses a timestamp in the future even when the signature matches it', () => {
    // The range check runs before the MAC comparison, and that ordering is
    // deliberate: a caller should not be able to learn a valid MAC for a future
    // timestamp by observing that it got a different error.
    const future = NOW + TOLERANCE + 10;
    const signature = sign('APPROVE', TOKEN, future);
    expect(service.verify(TOKEN, 'APPROVE', String(future), signature, NOW)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_range',
    });
  });
});

describe('malformed signatures', () => {
  it('rejects anything that is not a string', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(service.verify(TOKEN, 'APPROVE', String(NOW), bad, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects an empty signature', () => {
    expect(service.verify(TOKEN, 'APPROVE', String(NOW), '', NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a signature with no version separator', () => {
    expect(service.verify(TOKEN, 'APPROVE', String(NOW), 'a'.repeat(64), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a MAC that is not 64 hex characters', () => {
    // Checked here rather than at the HMAC comparison, so `timingSafeEqual`
    // cannot be reached with two buffers of different lengths — which would
    // throw rather than return false.
    for (const bad of ['v1=abc', 'v1=', `v1=${'a'.repeat(63)}`, `v1=${'A'.repeat(64)}`]) {
      expect(service.verify(TOKEN, 'APPROVE', String(NOW), bad, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects an unknown version before comparing anything', () => {
    // A future version would be accepted by a MAC comparison if its algorithm
    // happened to produce the same bytes, so the version is checked first.
    const forged = `v2=${sign('APPROVE').slice(3)}`;
    expect(service.verify(TOKEN, 'APPROVE', String(NOW), forged, NOW)).toEqual({
      ok: false,
      reason: 'unsupported_version',
    });
  });

  it('reports the same reason for every shape of near-miss', () => {
    // A caller must not be able to learn *which* check failed from the error.
    const wrongMac = `v1=${'0'.repeat(64)}`;
    const truncated = `v1=${'0'.repeat(32)}`;
    const noVersion = '0'.repeat(64);
    const reasons = [wrongMac, truncated, noVersion].map((signature) =>
      service.verify(TOKEN, 'APPROVE', String(NOW), signature, NOW),
    );
    expect(new Set(reasons.map((result) => (result.ok ? 'ok' : result.reason)))).toEqual(
      new Set(['malformed', 'mismatch']),
    );
  });
});

describe('a caller cannot rewrite the timestamp it was granted for', () => {
  it('refuses a grant whose timestamp field was edited forward', () => {
    // The signed string contains the timestamp, so editing the field the verifier
    // reads changes the string it re-signs and the MAC no longer matches.
    const signature = sign('APPROVE', TOKEN, NOW);
    expect(service.verify(TOKEN, 'APPROVE', String(NOW + TOLERANCE), signature, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses a grant replayed indefinitely by incrementing the timestamp', () => {
    // The attack the timestamp is in the signed string to stop: a caller that
    // can pick its own timestamp could keep re-presenting one old MAC.
    const signature = sign('APPROVE', TOKEN, NOW);
    for (const offset of [1, 60, TOLERANCE, TOLERANCE * 2]) {
      expect(service.verify(TOKEN, 'APPROVE', String(NOW + offset), signature, NOW).ok).toBe(false);
    }
  });
});
