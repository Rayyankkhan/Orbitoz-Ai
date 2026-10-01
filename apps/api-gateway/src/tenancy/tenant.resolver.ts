/**
 * Turns a request into a tenant.
 *
 * Resolution order, most explicit first:
 *
 *   1. An explicit header (API clients, the web app's server-side fetches).
 *   2. A custom domain, then the subdomain of the root domain.
 *
 * Deliberately not "the first tenant in the table" or "the only tenant": a
 * fallback that guesses a tenant is a cross-tenant data leak with extra steps.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { asTenantId, type ResolvedTenant } from '@orbitoz/shared-types';
import { PrismaService } from '@orbitoz/database';
import { EnvService } from '../config/env.service.js';

interface ResolvedTenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  suspended_at: Date | null;
}

@Injectable()
export class TenantResolver {
  private readonly logger = new Logger(TenantResolver.name);
  /** Per-process cache; the row changes rarely and resolution is on every request. */
  private readonly cache = new Map<string, { tenant: ResolvedTenant | null; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async resolveFromRequest(request: Request): Promise<ResolvedTenant | null> {
    const explicit = request.header(this.env.tenantHeader);
    const host = explicit ?? request.hostname ?? '';
    if (!host) return null;

    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.tenant;

    // A SECURITY DEFINER function, because RLS blocks reading `tenants` before
    // the tenant is known. It returns one row for one host and nothing else.
    const rows = await this.prisma.unscoped(
      (client) =>
        client.$queryRaw<ResolvedTenantRow[]>`
          SELECT id::text, slug, name, status, plan, suspended_at
          FROM app_resolve_tenant(${host})
        `,
      'tenant resolution (pre-scope, SECURITY DEFINER)',
    );

    const row = rows[0];
    if (!row) {
      // Negative cache: without it, every request to an unknown host is a
      // database round trip, which is exactly what a traffic spike on a
      // misconfigured domain looks like.
      this.cache.set(host, { tenant: null, expiresAt: Date.now() + 5_000 });
      return null;
    }

    const tenant: ResolvedTenant = {
      tenantId: asTenantId(row.id),
      slug: row.slug,
      name: row.name,
      status: row.status as ResolvedTenant['status'],
      plan: row.plan as ResolvedTenant['plan'],
      suspendedAt: row.suspended_at ? new Date(row.suspended_at).toISOString() : null,
    };

    this.cache.set(host, { tenant, expiresAt: Date.now() + 60_000 });
    this.logger.debug(`Resolved tenant ${tenant.slug} for host ${host}`);
    return tenant;
  }
}
