-- Lock down the PostgREST-exposed `public` schema.
--
-- The application uses custom Express JWTs plus server/Edge service-role access.
-- Browser clients never query application tables directly, so the Supabase
-- `anon` and `authenticated` roles must not hold table privileges.
--
-- This migration only changes privileges and RLS flags. It creates, alters and
-- drops no application object and touches no business data.

-- ---------------------------------------------------------------------------
-- 1. Existing objects
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- PUBLIC is a distinct grantee from anon/authenticated. A privilege held via
-- PUBLIC would survive the revokes above and remain reachable by every role.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

-- USAGE on the schema is intentionally left in place. Without table privileges
-- it grants no data access, and revoking it changes unrelated Supabase
-- introspection behaviour.

-- ---------------------------------------------------------------------------
-- 2. Future objects
-- ---------------------------------------------------------------------------
-- Default privileges are recorded per grantor role. A bare
-- `ALTER DEFAULT PRIVILEGES ... REVOKE` only affects entries created by the
-- role executing this migration, so it silently does nothing when the original
-- GRANT was issued by someone else. 20260528095000_remote_schema.sql records
-- these grants under `FOR ROLE "postgres"`, and Prisma creates future tables as
-- whichever role DATABASE_URL uses.
--
-- Rather than assume, this reads the actual grantors from pg_default_acl and
-- revokes for each one. Roles we lack membership in are reported instead of
-- aborting the migration, so the outcome is always visible.
DO $$
DECLARE
  grantor_name text;
  handled_count integer := 0;
BEGIN
  FOR grantor_name IN
    SELECT DISTINCT pg_get_userbyid(d.defaclrole)
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE n.nspname = 'public'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated',
        grantor_name);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated',
        grantor_name);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated',
        grantor_name);
      handled_count := handled_count + 1;
      RAISE NOTICE 'Revoked anon/authenticated default privileges granted by role %', grantor_name;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING
          'Could not alter default privileges for grantor role %. Re-run this migration as a member of that role, or future tables will still be granted to anon/authenticated.',
          grantor_name;
    END;
  END LOOP;

  IF handled_count = 0 THEN
    RAISE NOTICE 'No default privilege entries found for schema public.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------
-- ENABLE (not FORCE) is deliberate: the table owner and service_role must keep
-- working, since the Express backend and the Edge Functions are the only
-- intended data paths. With no policies defined, every other role is denied.
DO $$
DECLARE
  table_record record;
BEGIN
  FOR table_record IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
        table_record.schema_name,
        table_record.table_name);
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING
          'Could not enable RLS on %.% (not the owner).',
          table_record.schema_name, table_record.table_name;
    END;
  END LOOP;
END
$$;
