-- ===========================================================================
-- Orbitoz AI — application database role
--
--   pnpm db:roles          (or)      pnpm --filter @orbitoz/database roles:apply
--
-- WHY THIS FILE EXISTS
--
-- Row Level Security is not enforced for the table OWNER, and a superuser
-- bypasses it unconditionally. The docker-compose `postgres` service runs as
-- `orbitoz`, which is both the table owner AND a superuser, so connecting as
-- `orbitoz` silently disables every policy in rls.sql.
--
-- That makes local development the one place RLS is guaranteed to be off,
-- which is precisely backwards: it is where you most want it proven. So the
-- runtime gets its own role with no ownership and no bypass, and the tenancy
-- verification runs against that role to prove enforcement for real.
--
--   DIRECT_DATABASE_URL -> `orbitoz`  : migrations, seeds, role/RLS admin
--   APP_DATABASE_URL    -> `orbitoz_app` : the runtime application
--
-- SECURITY PROPERTIES ASSERTED HERE
--   NOSUPERUSER  superusers bypass RLS unconditionally
--   NOBYPASSRLS  the role-attribute that would otherwise skip policies
--   no ownership the app cannot alter a policy to let itself through
--   no CREATEROLE/CREATEDB it cannot escalate itself
--
-- RE-RUN REQUIREMENT
--
-- Prisma does not manage roles, so this file is NOT part of the migration
-- history and a `prisma migrate reset` will drop the grants. It is safe to
-- re-apply at any time — every statement is idempotent.
--
-- The password below is a DEVELOPMENT PLACEHOLDER. In staging/production the
-- role is created by the platform (Terraform, Cloud SQL IAM, RDS) with a
-- generated credential from the secret store, never from a committed file.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The role
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- Development-only. Overridden in production by the platform secret store.
  v_password text := 'orbitoz_app_dev_password';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbitoz_app') THEN
    RAISE NOTICE 'creating role orbitoz_app';
    EXECUTE format(
      'CREATE ROLE orbitoz_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
      v_password
    );
  ELSE
    -- Re-applying must still leave the security attributes correct, so that a
    -- role which was ever granted BYPASSRLS gets fixed rather than trusted.
    RAISE NOTICE 'role orbitoz_app exists; reasserting attributes';
    EXECUTE 'ALTER ROLE orbitoz_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Schema access
-- ---------------------------------------------------------------------------
GRANT CONNECT ON DATABASE orbitoz_db TO orbitoz_app;
GRANT USAGE ON SCHEMA public TO orbitoz_app;

-- ---------------------------------------------------------------------------
-- Table access
--
-- Grants the CRUD verbs only. The app role gets no TRUNCATE, no REFERENCES, no
-- TRIGGER, no MAINTAIN, and — because it does not own them — no ability to
-- disable RLS.
--
-- SELECT-only tables (users, refresh_tokens, provider_models) deliberately keep
-- their ordinary GRANT here: row visibility for those is the application's
-- job, and provider_models is intentionally readable by every tenant.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orbitoz_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orbitoz_app;

-- ---------------------------------------------------------------------------
-- Future tables
--
-- This is the part that matters most: without it, every migration that adds a
-- table produces a table the app role cannot read, and the failure surfaces as
-- a permissions error at runtime rather than at deploy time.
--
-- DEFAULT PRIVILEGES applies to objects created BY current_user (the migration
-- role), so it must be executed as the owner — which `prisma db execute` does
-- when given DIRECT_DATABASE_URL.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orbitoz_app',
    current_user
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT USAGE, SELECT ON SEQUENCES TO orbitoz_app',
    current_user
  );
END
$$;

-- ---------------------------------------------------------------------------
-- Helper functions
--
-- app_current_tenant(), app_tenant_unset() and app_resolve_tenant() live in
-- the public schema and are created by rls.sql. Functions are EXECUTE-to-PUBLIC
-- by default, so these grants are belt-and-braces, but making the dependency
-- explicit survives a future `REVOKE ... FROM PUBLIC`.
--
-- Guarded because this file and rls.sql reference each other: `db:setup` applies
-- roles first, so on a fresh database these functions do not exist yet. The check
-- is on the function's existence, not the order of application.
--
-- The signatures are held as text and resolved per iteration. Casting the array
-- literal to regprocedure[] up front would resolve every signature eagerly and
-- raise "function app_current_tenant() does not exist" before the guard could
-- run, which is exactly what this block exists to prevent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  signature text;
  resolved regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'app_current_tenant()',
    'app_tenant_unset()',
    'app_resolve_tenant(text)'
  ] LOOP
    resolved := to_regprocedure(signature);
    IF resolved IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO orbitoz_app', resolved);
    ELSE
      RAISE NOTICE 'skipping %: not created yet (apply rls.sql)', signature;
    END IF;
  END LOOP;
END
$$;
