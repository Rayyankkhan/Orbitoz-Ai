/**
 * Token service tests.
 *
 * The refresh-secret tests are the ones worth reading. Refresh tokens are opaque
 * strings, so there is no signature to forge — the only way to learn one is to
 * read it out of the `refresh_tokens` table. That makes "is a refresh token
 * rejected by the access-token verifier?" a property that has to be proven, not
 * assumed, and it is the reason the two secrets are separate.
 */
import { describe, expect, it } from 'vitest';
import { jwtVerify, SignJWT } from 'jose';
import {
  TOKEN_TYPE,
  TokenService,
  hashRefreshToken,
  type TokenServiceConfig,
} from './token.service.js';

const ACCESS_SECRET = 'test-access-secret-that-is-long-enough-0123456789';
const REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-9876543210';

function config(overrides: Partial<TokenServiceConfig> = {}): TokenServiceConfig {
  return {
    accessSecret: ACCESS_SECRET,
    refreshSecret: REFRESH_SECRET,
    accessTtlSeconds: 900,
    issuer: 'orbitoz.test',
    audience: 'orbitoz.test:api',
    clockToleranceSeconds: 0,
    ...overrides,
  };
}

const CLAIMS = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  role: 'DEVELOPER',
  email: 'dev@acme.test',
  userStatus: 'ACTIVE',
  isPlatformAdmin: false,
} as const;

describe('TokenService construction', () => {
  it('refuses a secret shorter than the HS256 minimum', () => {
    // jose throws deep inside a request if given a short key. Failing at
    // construction means the error names the variable.
    expect(() => new TokenService(config({ accessSecret: 'too-short' }))).toThrow(
      /JWT_ACCESS_SECRET must be at least 32 bytes/,
    );
    expect(() => new TokenService(config({ refreshSecret: 'too-short' }))).toThrow(
      /JWT_REFRESH_SECRET must be at least 32 bytes/,
    );
  });
});

describe('access tokens', () => {
  it('issues a token that verifies back to the same claims', async () => {
    const service = new TokenService(config());
    const { token, expiresIn } = await service.issueAccessToken(CLAIMS);

    expect(expiresIn).toBe(900);

    const result = await service.verifyAccessToken(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.claims.userId).toBe(CLAIMS.userId);
    expect(result.claims.tenantId).toBe(CLAIMS.tenantId);
    expect(result.claims.role).toBe('DEVELOPER');
    expect(result.claims.email).toBe(CLAIMS.email);
    expect(result.claims.userStatus).toBe('ACTIVE');
    expect(result.claims.isPlatformAdmin).toBe(false);
    expect(result.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives every token a distinct jti', async () => {
    // jti is what makes a specific token nameable in an audit log.
    const service = new TokenService(config());
    const [a, b] = await Promise.all([
      service.issueAccessToken(CLAIMS),
      service.issueAccessToken(CLAIMS),
    ]);
    expect(a.jti).not.toBe(b.jti);
  });

  it('carries both ids in the payload, so the guard needs no database read', async () => {
    const service = new TokenService(config());
    const { token } = await service.issueAccessToken(CLAIMS);

    const { payload } = await jwtVerify(token, new TextEncoder().encode(ACCESS_SECRET), {
      algorithms: ['HS256'],
    });

    expect(payload.sub).toBe(CLAIMS.userId);
    expect(payload.tid).toBe(CLAIMS.tenantId);
    expect(payload.typ).toBe(TOKEN_TYPE.Access);
    expect(payload.iss).toBe('orbitoz.test');
    expect(payload.aud).toBe('orbitoz.test:api');
  });

  it('rejects a token signed with a different secret', async () => {
    const issuer = new TokenService(config());
    const other = new TokenService(
      config({ accessSecret: 'a-completely-different-secret-0123456789ab' }),
    );

    const { token } = await issuer.issueAccessToken(CLAIMS);
    const result = await other.verifyAccessToken(token);

    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload', async () => {
    const service = new TokenService(config());
    const { token } = await service.issueAccessToken(CLAIMS);

    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      tid: string;
      role: string;
    };
    // The most direct attack there is: an OWNER role for another tenant.
    claims.tid = '33333333-3333-4333-8333-333333333333';
    claims.role = 'OWNER';
    const forged = [
      header,
      Buffer.from(JSON.stringify(claims)).toString('base64url'),
      signature,
    ].join('.');

    expect((await service.verifyAccessToken(forged)).ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    // ttl 1s, then wait past it. The tolerance is 0 so the test is not
    // dependent on the machine's clock resolution.
    const service = new TokenService(config({ accessTtlSeconds: 1, clockToleranceSeconds: 0 }));
    const { token } = await service.issueAccessToken(CLAIMS);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(await service.verifyAccessToken(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a token that expired within the clock tolerance', async () => {
    // Two nodes whose clocks differ by a few hundred milliseconds must not
    // reject each other's freshly minted tokens.
    const issuer = new TokenService(config({ accessTtlSeconds: 1, clockToleranceSeconds: 5 }));
    const verifier = new TokenService(config({ accessTtlSeconds: 1, clockToleranceSeconds: 5 }));

    const { token } = await issuer.issueAccessToken(CLAIMS);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect((await verifier.verifyAccessToken(token)).ok).toBe(true);
  });

  it('rejects a token from another issuer', async () => {
    const foreign = new TokenService(config({ issuer: 'evil.test' }));
    const { token } = await foreign.issueAccessToken(CLAIMS);

    const result = await new TokenService(config()).verifyAccessToken(token);
    expect(result).toEqual({ ok: false, reason: 'wrong_issuer' });
  });

  it('rejects a token for another audience', async () => {
    // Guards against a token minted for a different service in the same org.
    const foreign = new TokenService(config({ audience: 'orbitoz.test:internal' }));
    const { token } = await foreign.issueAccessToken(CLAIMS);

    const result = await new TokenService(config()).verifyAccessToken(token);
    expect(result).toEqual({ ok: false, reason: 'wrong_audience' });
  });

  it('rejects an unsigned alg:none token', async () => {
    // `alg: none`, the original JWT attack. jose refuses to *sign* one, so the
    // token is assembled by hand — which is exactly what an attacker would do.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: CLAIMS.userId,
        tid: CLAIMS.tenantId,
        role: 'OWNER',
        email: CLAIMS.email,
        ust: CLAIMS.userStatus,
        pad: true,
        typ: TOKEN_TYPE.Access,
        iss: 'orbitoz.test',
        aud: 'orbitoz.test:api',
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url');

    expect((await new TokenService(config()).verifyAccessToken(`${header}.${payload}.`)).ok).toBe(
      false,
    );
  });

  it('rejects a token that does not carry a token type', async () => {
    const untyped = await new SignJWT({
      sub: CLAIMS.userId,
      tid: CLAIMS.tenantId,
      role: CLAIMS.role,
      email: CLAIMS.email,
      ust: CLAIMS.userStatus,
      pad: false,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('orbitoz.test')
      .setAudience('orbitoz.test:api')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(ACCESS_SECRET));

    expect(await new TokenService(config()).verifyAccessToken(untyped)).toEqual({
      ok: false,
      reason: 'wrong_type',
    });
  });

  it('rejects a correctly typed token that is missing required claims', async () => {
    // Distinct from the case above: `typ` is right, but a required claim is
    // absent or of the wrong type. Without this check a partially-forged payload
    // would reach a handler holding `undefined` ids.
    const partial = await new SignJWT({ sub: CLAIMS.userId, typ: TOKEN_TYPE.Access })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('orbitoz.test')
      .setAudience('orbitoz.test:api')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(ACCESS_SECRET));

    expect(await new TokenService(config()).verifyAccessToken(partial)).toEqual({
      ok: false,
      reason: 'missing_claims',
    });
  });

  for (const label of ['an empty string', 'random text', 'two segments', 'four segments']) {
    it(`rejects ${label} as malformed`, async () => {
      const malformed = {
        'an empty string': '',
        'random text': 'not-a-token',
        'two segments': 'aaa.bbb',
        'four segments': 'a.b.c.d',
      }[label];
      expect(await new TokenService(config()).verifyAccessToken(malformed ?? '')).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });
  }
});

describe('refresh tokens', () => {
  it('issues an opaque token distinct from any JWT', () => {
    // Opaque, not signed: it has to be looked up on every use so it can be
    // revoked. A signed refresh token could not be, which is the whole reason
    // this is not a JWT.
    const service = new TokenService(config());
    const { token } = service.issueRefreshToken();

    expect(token.startsWith('ort_')).toBe(true);
    expect(token.split('.')).toHaveLength(1);
  });

  it('never returns the same token twice', () => {
    const service = new TokenService(config());
    const issued = new Set(Array.from({ length: 200 }, () => service.issueRefreshToken().token));
    expect(issued.size).toBe(200);
  });

  it('hashes deterministically, so a lookup can find the row', () => {
    const service = new TokenService(config());
    const { token } = service.issueRefreshToken();

    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different hash for a different token', () => {
    const service = new TokenService(config());
    expect(hashRefreshToken(service.issueRefreshToken().token)).not.toBe(
      hashRefreshToken(service.issueRefreshToken().token),
    );
  });
});

describe('access and refresh secrets are independent', () => {
  it('rejects a refresh token presented as an access token', async () => {
    // The core reason JWT_REFRESH_SECRET exists. Refresh tokens are opaque
    // strings, so they cannot be a valid JWT at all — but the guarantee has to
    // be tested, because the moment someone "simplifies" refresh tokens into
    // JWTs signed with the access key, this is the test that fails.
    const service = new TokenService(config());
    const { token } = service.issueRefreshToken();

    expect(await service.verifyAccessToken(token)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an access token signed with the refresh secret', async () => {
    const forged = await new SignJWT({
      sub: CLAIMS.userId,
      tid: CLAIMS.tenantId,
      role: 'OWNER',
      email: CLAIMS.email,
      ust: CLAIMS.userStatus,
      pad: false,
      typ: TOKEN_TYPE.Access,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('orbitoz.test')
      .setAudience('orbitoz.test:api')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(REFRESH_SECRET));

    expect(await new TokenService(config()).verifyAccessToken(forged)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

describe('peekUnverified', () => {
  it('reads the ids out of a valid token', async () => {
    const service = new TokenService(config());
    const { token } = await service.issueAccessToken(CLAIMS);

    expect(service.peekUnverified(token)).toEqual({
      userId: CLAIMS.userId,
      tenantId: CLAIMS.tenantId,
    });
  });

  it('still reads the ids out of a token that does not verify', async () => {
    // The point of the method: "a token for tenant X was refused" is worth
    // logging, and the signature says nothing about whether X is the real id.
    const service = new TokenService(config());
    const foreign = new TokenService(
      config({ accessSecret: 'another-secret-entirely-0123456789abcd' }),
    );
    const { token } = await foreign.issueAccessToken(CLAIMS);

    expect((await service.verifyAccessToken(token)).ok).toBe(false);
    expect(service.peekUnverified(token)?.tenantId).toBe(CLAIMS.tenantId);
  });

  for (const label of ['an empty string', 'not a jwt', 'a non-JSON payload']) {
    it(`returns null for ${label}`, () => {
      const input = {
        'an empty string': '',
        'not a jwt': 'nonsense',
        'a non-JSON payload': `aaa.${Buffer.from('not json').toString('base64url')}.ccc`,
      }[label];
      expect(new TokenService(config()).peekUnverified(input ?? '')).toBeNull();
    });
  }
});
