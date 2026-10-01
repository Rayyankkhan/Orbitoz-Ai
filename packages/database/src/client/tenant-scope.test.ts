import { describe, expect, it } from 'vitest';

import {
  TenantScopeError,
  TenantTransactionRequiredError,
  currentTenantScope,
  isRlsEnforced,
  optionalTenantId,
  requireTenantId,
  runWithTenant,
  setRlsEnforcement,
} from './tenant-scope.js';

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('runWithTenant', () => {
  it('exposes the scope synchronously inside the callback', () => {
    runWithTenant({ tenantId: TENANT_A }, () => {
      expect(currentTenantScope()?.tenantId).toBe(TENANT_A);
    });
  });

  it('propagates the scope into async continuations', async () => {
    const seen = await runWithTenant({ tenantId: TENANT_A }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return optionalTenantId();
    });

    expect(seen).toBe(TENANT_A);
  });

  it('propagates into a nested run and restores the outer scope afterwards', () => {
    const outer = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const inner = 'bbbbbbbb-0000-4000-8000-00000000000b';

    const observed = runWithTenant({ tenantId: outer }, () => {
      const before = requireTenantId();
      const during = runWithTenant({ tenantId: inner }, () => requireTenantId());
      const after = requireTenantId();
      return { before, during, after };
    });

    expect(observed).toEqual({ before: outer, during: inner, after: outer });
  });

  it('subscribes to a returned thenable before the scope closes', async () => {
    // This is the reason runWithTenant returns an awaited value rather than a
    // bare handle: a Prisma query builder is lazy, so awaiting it has to happen
    // *inside* the scope or the extension reads the wrong ambient store.
    const lazy = {
      // A PromiseLike's `then` must return a promise that fulfills with whatever
      // `onFulfilled` produced. Dropping it here would make the double promise
      // `undefined` and hide what the assertion below is actually checking.
      then(onFulfilled: (value: string) => void): Promise<string> {
        return Promise.resolve(onFulfilled(optionalTenantId() ?? 'missing'));
      },
    };

    const result = await runWithTenant({ tenantId: TENANT_A }, () => lazy);

    expect(result).toBe(TENANT_A);
  });

  it('clears the scope when the callback throws', () => {
    expect(() =>
      runWithTenant({ tenantId: TENANT_A }, () => {
        throw new TenantScopeError('boom');
      }),
    ).toThrow('boom');

    expect(currentTenantScope()).toBeUndefined();
  });

  it('does not leak scope between sequential runs', () => {
    runWithTenant({ tenantId: TENANT_A }, () => undefined);
    expect(currentTenantScope()).toBeUndefined();
  });

  it('keeps concurrent runs isolated', async () => {
    const a = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const b = 'bbbbbbbb-0000-4000-8000-00000000000b';

    const [seenA, seenB] = await Promise.all([
      runWithTenant({ tenantId: a }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return requireTenantId();
      }),
      runWithTenant({ tenantId: b }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return requireTenantId();
      }),
    ]);

    expect(seenA).toBe(a);
    expect(seenB).toBe(b);
  });
});

describe('requireTenantId', () => {
  it('throws rather than returning undefined when no tenant is active', () => {
    // Returning undefined would flow into a query that either leaks or returns
    // nothing; both are worse than a stack trace at the call site.
    expect(() => requireTenantId()).toThrow(TenantScopeError);
  });

  it('returns null from optionalTenantId', () => {
    expect(optionalTenantId()).toBeNull();
  });
});

describe('RLS enforcement guard', () => {
  it('reports whether enforcement is detected', () => {
    const original = isRlsEnforced();
    try {
      setRlsEnforcement(true);
      expect(isRlsEnforced()).toBe(true);

      setRlsEnforcement(false);
      expect(isRlsEnforced()).toBe(false);
    } finally {
      setRlsEnforcement(original);
    }
  });

  it('exposes a distinguishable error type for unpinned queries', () => {
    const error = new TenantTransactionRequiredError('conversation', 'findMany');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TenantTransactionRequiredError');
  });
});
