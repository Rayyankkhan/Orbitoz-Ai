import { describe, expect, it } from 'vitest';

import { applyTenantScopeToArgs, hasWhere, isRowCountingOperation } from './tenant-args.js';
import { TenantScopeError } from './tenant-scope.js';

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

/** Applies scoping and asserts the operation is one we expect to be rewritten. */
function scope(operation: string, args: unknown, tenantId = TENANT_A): Record<string, unknown> {
  return applyTenantScopeToArgs(operation, args, tenantId);
}

describe('applyTenantScopeToArgs', () => {
  describe('reads', () => {
    it('injects tenantId into findMany', () => {
      expect(scope('findMany', {})).toEqual({ where: { tenantId: TENANT_A } });
    });

    it('keeps the caller’s own filters', () => {
      // Spreading caller conditions *after* the injected tenantId would let a
      // caller-supplied tenantId win, which is the bug this guards against.
      const result = scope('findMany', {
        where: { status: 'ACTIVE', archivedAt: null },
      });
      expect(result.where).toEqual({
        tenantId: TENANT_A,
        status: 'ACTIVE',
        archivedAt: null,
      });
    });

    it('refuses to let a caller override the scope on a read', () => {
      expect(() => scope('findMany', { where: { tenantId: TENANT_B } })).toThrow(TenantScopeError);
    });

    it('scopes every filtered read and write', () => {
      for (const operation of [
        'findUnique',
        'findUniqueOrThrow',
        'findFirst',
        'findFirstOrThrow',
        'findMany',
        'update',
        'updateMany',
        'delete',
        'deleteMany',
      ]) {
        expect(scope(operation, {}).where).toEqual({ tenantId: TENANT_A });
      }
    });
  });

  describe('creates', () => {
    it('injects tenantId into create data', () => {
      expect(scope('create', { data: { title: 'hello' } })).toEqual({
        data: { title: 'hello', tenantId: TENANT_A },
      });
    });

    it('rebuilds the data object rather than mutating the caller’s', () => {
      // Rebuilding is load-bearing: Prisma picks UncheckedCreateInput only when
      // the object identity changes, otherwise it demands the `tenant` relation.
      const args = { data: { title: 'hello' } };
      const result = scope('create', args);

      expect(args).toEqual({ data: { title: 'hello' } });
      expect(result.data).not.toBe(args.data);
    });

    it('allows a create that already names the active tenant', () => {
      expect(() => scope('create', { data: { tenantId: TENANT_A } })).not.toThrow();
    });

    it('rejects a create naming a different tenant', () => {
      expect(() => scope('create', { data: { tenantId: TENANT_B } })).toThrow(
        /Cross-tenant writes are rejected/,
      );
    });

    it('injects tenantId into every row of a createMany', () => {
      const result = scope('createMany', { data: [{ a: 1 }, { a: 2 }] });
      expect(result.data).toEqual([
        { a: 1, tenantId: TENANT_A },
        { a: 2, tenantId: TENANT_A },
      ]);
    });

    it('rejects a createMany with a foreign tenantId in any row', () => {
      expect(() => scope('createMany', { data: [{ a: 1 }, { tenantId: TENANT_B }] })).toThrow(
        TenantScopeError,
      );
    });

    it('rejects createMany whose data is not an array', () => {
      // Silently accepting a non-array would mean scoping nothing and writing
      // rows with no tenant at all.
      expect(() => scope('createMany', { data: { a: 1 } })).toThrow(/must be an array/);
      expect(() => scope('createManyAndReturn', { data: 'nope' })).toThrow(/must be an array/);
    });

    it('injects tenantId into createManyAndReturn', () => {
      const result = scope('createManyAndReturn', { data: [{ a: 1 }] });
      expect(result.data).toEqual([{ a: 1, tenantId: TENANT_A }]);
    });
  });

  describe('upsert', () => {
    it('scopes where, create and update', () => {
      const result = scope('upsert', {
        where: { id: 'abc' },
        create: { title: 'new' },
        update: { title: 'changed' },
      });

      expect(result).toEqual({
        where: { tenantId: TENANT_A, id: 'abc' },
        create: { title: 'new', tenantId: TENANT_A },
        update: { title: 'changed', tenantId: TENANT_A },
      });
    });

    it('preserves the caller’s update payload', () => {
      // Regression test. An earlier version read `update` off the *create*
      // object, so every upsert silently replaced the caller's update data with
      // just `{ tenantId }` — losing the write entirely.
      const result = scope('upsert', {
        where: { id: 'abc' },
        create: { title: 'new' },
        update: { title: 'changed', archivedAt: null },
      });

      expect(result.update).toEqual({
        title: 'changed',
        archivedAt: null,
        tenantId: TENANT_A,
      });
    });

    it('does not read update fields out of the create payload', () => {
      // Guards the specific shape of the regression above.
      const result = scope('upsert', {
        create: { title: 'new' },
        update: { title: 'changed' },
      });
      expect(result.update).not.toHaveProperty('title', 'new');
    });

    it('rejects a foreign tenantId on either half', () => {
      expect(() => scope('upsert', { create: { tenantId: TENANT_B }, update: {} })).toThrow(
        TenantScopeError,
      );
      expect(() => scope('upsert', { create: {}, update: { tenantId: TENANT_B } })).toThrow(
        TenantScopeError,
      );
    });

    it('tolerates a missing update half', () => {
      expect(() => scope('upsert', { create: { title: 'x' } })).not.toThrow();
    });
  });

  describe('row counting', () => {
    it('scopes a count that already filters', () => {
      expect(scope('count', { where: { status: 'ACTIVE' } }).where).toEqual({
        tenantId: TENANT_A,
        status: 'ACTIVE',
      });
    });

    it('leaves a bare count alone', () => {
      // Rewriting a bare count would change the query shape and return zero
      // rather than a tenant-wide count the caller asked for.
      expect(scope('count', {})).toEqual({});
    });

    it('identifies counting operations', () => {
      expect(isRowCountingOperation('count')).toBe(true);
      expect(isRowCountingOperation('aggregate')).toBe(true);
      expect(isRowCountingOperation('groupBy')).toBe(true);
      expect(isRowCountingOperation('findMany')).toBe(false);
    });
  });

  describe('purity', () => {
    it('never mutates the caller’s args', () => {
      const args = { where: { id: 'abc' }, data: { title: 'x' } };
      const snapshot = structuredClone(args);

      scope('upsert', args);
      scope('findMany', args);
      scope('create', args);

      expect(args).toEqual(snapshot);
    });

    it('detects a present where clause', () => {
      expect(hasWhere({ where: {} })).toBe(true);
      expect(hasWhere({ where: undefined })).toBe(false);
      expect(hasWhere({})).toBe(false);
      expect(hasWhere(null)).toBe(false);
    });
  });

  describe('error messages', () => {
    it('names the offending value even when it is not a string', () => {
      // String(object) is "[object Object]", which hides what actually happened.
      let message = '';
      try {
        scope('create', { data: { tenantId: { id: TENANT_B } } });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(TENANT_B);
      expect(message).toContain('Cross-tenant writes are rejected');
    });
  });
});
