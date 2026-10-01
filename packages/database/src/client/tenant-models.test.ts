import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import {
  GLOBAL_MODELS,
  TENANT_SCOPED_MODELS,
  isTenantScopedModel,
  unclassifiedModels,
} from './tenant-models.js';

describe('model classification', () => {
  it('classifies every model in the schema', () => {
    // Prisma.ModelName is generated from schema.prisma, so this comparison
    // cannot drift the way a hand-maintained list would. A model with no policy
    // is readable by every tenant.
    const all = Object.values(Prisma.ModelName);
    expect(unclassifiedModels(all)).toEqual([]);
  });

  it('keeps the two sets disjoint', () => {
    for (const model of TENANT_SCOPED_MODELS) {
      expect(GLOBAL_MODELS.has(model)).toBe(false);
    }
  });

  it('uses PascalCase names', () => {
    // Prisma 7 passes the schema name to extensions, not the camelCase client
    // property. A lowercase entry here would silently match nothing.
    for (const model of TENANT_SCOPED_MODELS) {
      expect(model).toMatch(/^[A-Z]/);
    }
  });

  it('treats Tenant as global, since a tenant is resolved before one is known', () => {
    // Tenant is the lookup table itself. Injecting the active tenantId into a
    // Tenant query would make tenant resolution impossible — the extension has
    // no scope yet at the point it needs to find one.
    expect(isTenantScopedModel('Tenant')).toBe(false);
    expect(GLOBAL_MODELS.has('Tenant')).toBe(true);
  });

  it('treats an internal Prisma model as neither scoped nor known', () => {
    // `_Migrations` is Prisma's bookkeeping table. It is not in either set,
    // which is why `isTenantScopedModel` must default to false rather than
    // throwing: a model the extension does not recognise stays untouched.
    expect(isTenantScopedModel('_Migrations')).toBe(false);
    expect(TENANT_SCOPED_MODELS.has('_Migrations')).toBe(false);
    expect(GLOBAL_MODELS.has('_Migrations')).toBe(false);
  });

  it('defaults to global for an unknown model', () => {
    // Fail-closed: a model nobody classified is not quietly treated as another
    // tenant's data.
    expect(isTenantScopedModel('SomethingNew')).toBe(false);
  });

  it('reports models missing from both sets', () => {
    expect(unclassifiedModels(['Conversation', 'SomethingNew', 'AlsoNew'])).toEqual([
      'SomethingNew',
      'AlsoNew',
    ]);
  });

  it('reports nothing for an empty list', () => {
    expect(unclassifiedModels([])).toEqual([]);
  });
});
