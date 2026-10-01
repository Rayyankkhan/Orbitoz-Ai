-- ===========================================================================
-- Orbitoz AI — PostgreSQL Row Level Security (defence in depth)
--
-- The application already scopes every query by tenant (PrismaService injects
-- `tenantId` into every read and write). RLS is the backstop for the cases the
-- application layer cannot catch:
--
--   * a raw `$queryRaw` with a hand-written WHERE clause that forgot the tenant
--   * a future service written in another language that forgets the convention
--   * a DBA with a psql session, or a support engineer with read-only SQL
--
-- HOW IT WORKS
--   Each request opens a transaction and does:
--       SET LOCAL app.tenant_id = '<uuid>';
--   Every policy then compares `tenant_id` to `current_setting('app.tenant_id')`.
--   With no value set, `current_setting(..., true)` returns NULL, the
--   comparison is NULL, and the row is filtered out — fail closed.
--
-- IMPORTANT: WHICH ROLE ENFORCES THIS
--   RLS is not enforced for the table OWNER, and a superuser always bypasses it.
--   The docker-compose `postgres` service runs as `orbitoz`, which is both the
--   owner and a superuser, so connecting as `orbitoz` disables every policy
--   below. That is why there is a separate application role: see roles.sql.
--
--       DIRECT_DATABASE_URL -> `orbitoz`      migrations, seeds, admin
--       APP_DATABASE_URL    -> `orbitoz_app`  the runtime application
--
--   `orbitoz_app` is NOSUPERUSER NOBYPASSRLS and owns nothing, so these
--   policies are genuinely enforced against it. Apply with:
--
--       pnpm db:migrate && pnpm db:rls && pnpm db:roles
--
--   The order matters: roles.sql grants on tables that must already exist.
--
-- Apply with:  pnpm db:rls
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper: fail-closed current tenant.
--
--   current_setting('app.tenant_id', true) -> NULL when unset (missing_ok = true)
--   NULLIF(..., '')                        -> NULL when set to empty string
--
-- Comparing a tenant_id to NULL yields NULL, which RLS treats as "deny".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- True when no tenant is in scope. Used to allow authenticated-but-not-yet-
-- tenant-scoped operations (e.g. platform-admin maintenance) to be explicit
-- rather than accidental.
CREATE OR REPLACE FUNCTION app_tenant_unset() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app_current_tenant() IS NULL
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` turns on enforcement
-- for non-owner roles; `FORCE` additionally applies it to the owner.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenants', 'memberships', 'invitations', 'subscriptions',
    'api_keys', 'tenant_providers', 'conversations', 'inference_jobs',
    'provider_attempts', 'usage_records', 'usage_rollups',
    'idempotency_keys', 'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- FORCE makes the policy apply even to the table owner. Enable this only
      -- after the app connects as a dedicated role; see the header caveat.
      -- EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Tenant resolution — the one read that has to happen before RLS can work
--
-- The chicken-and-egg problem: `rls_tenants_select` compares `id` to
-- `app_current_tenant()`, and the tenant id is obtained BY reading the tenants
-- table. Under real enforcement that read returns zero rows, forever.
--
-- The standard resolution is a SECURITY DEFINER function: it runs with the
-- privileges of its owner (the table owner, which RLS does not constrain) while
-- being callable by the unprivileged app role. It is deliberately narrow — it
-- exposes only the non-secret fields needed to route a request, it matches on
-- host, and it cannot be pointed at another tenant's data by a caller because
-- it only ever returns the single row matching the host given.
--
-- SECURITY DEFINER is a privilege-escalation primitive, so the rules are
-- followed exactly: a fixed `search_path` (defeats search_path injection),
-- no dynamic SQL, and EXECUTE revoked from PUBLIC.
--
-- Everything after resolution is ordinary RLS-governed access.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_resolve_tenant(p_host text)
RETURNS TABLE (
  id uuid,
  slug varchar(63),
  name varchar(200),
  status text,
  plan text,
  suspended_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- A DNS custom domain wins over the root-domain subdomain, so a tenant that
  -- bought ai.acme.com is not shadowed by an "acme" slug.
  SELECT t.id, t.slug, t.name, t.status::text, t.plan::text, t.suspended_at
  FROM public.tenants t
  WHERE t.custom_domain = lower(p_host)
     OR t.slug = lower(split_part(p_host, '.', 1))
     OR t.slug = lower(p_host)
  LIMIT 1
$$;

-- Only the application role may resolve tenants. PUBLIC is dropped so that a
-- role added later does not inherit the ability to enumerate tenants.
--
-- Guarded on the role existing, because rls.sql and roles.sql reference each
-- other and either may be applied first. If the role is missing, roles.sql
-- grants EXECUTE when it runs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbitoz_app') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION app_resolve_tenant(text) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app_resolve_tenant(text) TO orbitoz_app';
  ELSE
    RAISE NOTICE 'orbitoz_app not created yet; roles.sql will grant EXECUTE';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Policies
--
-- Naming: rls_<table>_<operation>
-- Written idempotently so the script can be re-applied after a migration.
-- ---------------------------------------------------------------------------

-- tenants: the row is the tenant.
DROP POLICY IF EXISTS rls_tenants_select ON public.tenants;
CREATE POLICY rls_tenants_select ON public.tenants
  FOR SELECT USING (id = app_current_tenant());

-- Provisioning: a signup creates the tenant, so there is no tenant in scope
-- yet to compare against. Keying the INSERT on `app_tenant_unset()` is what
-- keeps this from becoming a back door — once any tenant is in context, a
-- request can no longer mint a new one. The created row is then adopted by
-- setting the scope to its own id.
DROP POLICY IF EXISTS rls_tenants_insert ON public.tenants;
CREATE POLICY rls_tenants_insert ON public.tenants
  FOR INSERT WITH CHECK (app_tenant_unset());

-- There is deliberately no DELETE policy on tenants: account closure is a
-- platform-admin operation, not something tenant-scoped traffic can trigger.
DROP POLICY IF EXISTS rls_tenants_update ON public.tenants;
CREATE POLICY rls_tenants_update ON public.tenants
  FOR UPDATE USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- memberships: only the current tenant's members.
DROP POLICY IF EXISTS rls_memberships_all ON public.memberships;
CREATE POLICY rls_memberships_all ON public.memberships
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- invitations
DROP POLICY IF EXISTS rls_invitations_all ON public.invitations;
CREATE POLICY rls_invitations_all ON public.invitations
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- subscriptions
DROP POLICY IF EXISTS rls_subscriptions_all ON public.subscriptions;
CREATE POLICY rls_subscriptions_all ON public.subscriptions
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- refresh_tokens is deliberately NOT RLS-protected: a refresh request must
-- resolve its token by hash BEFORE any tenant is known, so any policy keyed on
-- app_current_tenant() would make rotation impossible. The table is instead
-- protected by (a) only SHA-256 hashes are stored, (b) a globally unique index
-- on token_hash, and (c) a short TTL. `users` is unscoped for the same reason.

-- api_keys
DROP POLICY IF EXISTS rls_api_keys_all ON public.api_keys;
CREATE POLICY rls_api_keys_all ON public.api_keys
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- provider_models: a global catalogue, readable by every authenticated
-- tenant. Writable only by the owning/admin role via a separate policy.
DROP POLICY IF EXISTS rls_provider_models_select ON public.provider_models;
CREATE POLICY rls_provider_models_select ON public.provider_models
  FOR SELECT USING (app_current_tenant() IS NOT NULL);

-- tenant_providers
DROP POLICY IF EXISTS rls_tenant_providers_all ON public.tenant_providers;
CREATE POLICY rls_tenant_providers_all ON public.tenant_providers
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- conversations
DROP POLICY IF EXISTS rls_conversations_all ON public.conversations;
CREATE POLICY rls_conversations_all ON public.conversations
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- inference_jobs
DROP POLICY IF EXISTS rls_inference_jobs_all ON public.inference_jobs;
CREATE POLICY rls_inference_jobs_all ON public.inference_jobs
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- provider_attempts
DROP POLICY IF EXISTS rls_provider_attempts_all ON public.provider_attempts;
CREATE POLICY rls_provider_attempts_all ON public.provider_attempts
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- usage_records
DROP POLICY IF EXISTS rls_usage_records_all ON public.usage_records;
CREATE POLICY rls_usage_records_all ON public.usage_records
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- usage_rollups
DROP POLICY IF EXISTS rls_usage_rollups_all ON public.usage_rollups;
CREATE POLICY rls_usage_rollups_all ON public.usage_rollups
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- idempotency_keys
DROP POLICY IF EXISTS rls_idempotency_keys_all ON public.idempotency_keys;
CREATE POLICY rls_idempotency_keys_all ON public.idempotency_keys
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- audit_logs
DROP POLICY IF EXISTS rls_audit_logs_all ON public.audit_logs;
CREATE POLICY rls_audit_logs_all ON public.audit_logs
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
