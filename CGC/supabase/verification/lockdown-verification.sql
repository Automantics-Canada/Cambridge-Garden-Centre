-- Verification for 20260812150000_lock_down_public_schema.sql
--
-- NOT a migration. This file lives outside supabase/migrations so the CLI never
-- applies it. Run it manually, and read the warning above section C.
--
-- Sections A and B are read-only and safe to run anywhere, including production.
-- Section C creates and drops a throwaway table and must only be run against a
-- staging or restored-backup database.
--
-- None of these queries were executed during the change that introduced them.
-- Expected results are stated so the operator can compare against real output.


-- ===========================================================================
-- A. Existing tables: anon and authenticated must hold no privileges
-- ===========================================================================
-- EXPECTED: zero rows.
SELECT
  t.table_name,
  r.rolname AS grantee,
  p.privilege
FROM information_schema.tables t
CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) r
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege)
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  AND has_table_privilege(r.rolname, format('public.%I', t.table_name), p.privilege)
ORDER BY t.table_name, r.rolname, p.privilege;


-- Same check via the grant catalogue, including privileges held through PUBLIC.
-- EXPECTED: zero rows.
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;


-- RLS must be enabled on every base table in public.
-- EXPECTED: zero rows.
SELECT n.nspname AS schema_name, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND NOT c.relrowsecurity
ORDER BY c.relname;


-- ===========================================================================
-- B. Future tables: no default privileges may remain for anon/authenticated
-- ===========================================================================
-- This is the check that plain `ALTER DEFAULT PRIVILEGES ... REVOKE` fails to
-- satisfy when the migration runs as a different grantor than the original
-- GRANT used. Each row shows a grantor whose future objects would still be
-- exposed.
-- EXPECTED: zero rows.
SELECT
  pg_get_userbyid(d.defaclrole) AS grantor_role,
  d.defaclobjtype             AS object_type,   -- r=table, S=sequence, f=function
  d.defaclacl                 AS acl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public'
  AND EXISTS (
    SELECT 1
    FROM unnest(d.defaclacl) AS entry
    WHERE entry::text LIKE 'anon=%'
       OR entry::text LIKE 'authenticated=%'
  );


-- Full default-ACL dump, for the record. Review that no entry grants to
-- anon or authenticated.
SELECT
  pg_get_userbyid(d.defaclrole) AS grantor_role,
  n.nspname                     AS schema_name,
  d.defaclobjtype               AS object_type,
  d.defaclacl                   AS acl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public'
ORDER BY grantor_role, object_type;


-- ===========================================================================
-- C. New-table check  --  STAGING ONLY, DO NOT RUN ON PRODUCTION
-- ===========================================================================
-- Proves that a table created *after* the migration does not inherit access for
-- anon/authenticated. It creates and drops its own throwaway table and touches
-- no application object, but it is still DDL: run it only against staging or a
-- restored backup.
--
-- Run this as the same role that creates application tables (the role in
-- DATABASE_URL), otherwise it proves nothing about Prisma-created tables.
--
-- EXPECTED: every has_table_privilege column below returns false.
--
-- BEGIN;
--   CREATE TABLE public._lockdown_probe (id integer PRIMARY KEY);
--
--   SELECT
--     current_user AS created_by,
--     has_table_privilege('anon',          'public._lockdown_probe', 'SELECT') AS anon_select,
--     has_table_privilege('anon',          'public._lockdown_probe', 'INSERT') AS anon_insert,
--     has_table_privilege('anon',          'public._lockdown_probe', 'UPDATE') AS anon_update,
--     has_table_privilege('anon',          'public._lockdown_probe', 'DELETE') AS anon_delete,
--     has_table_privilege('authenticated', 'public._lockdown_probe', 'SELECT') AS auth_select,
--     has_table_privilege('authenticated', 'public._lockdown_probe', 'INSERT') AS auth_insert,
--     has_table_privilege('authenticated', 'public._lockdown_probe', 'UPDATE') AS auth_update,
--     has_table_privilege('authenticated', 'public._lockdown_probe', 'DELETE') AS auth_delete;
--
--   DROP TABLE public._lockdown_probe;
-- ROLLBACK;
--
-- ROLLBACK is used rather than COMMIT so the probe leaves no trace even if the
-- DROP is not reached.


-- ===========================================================================
-- D. Service paths must still work
-- ===========================================================================
-- The backend and Edge Functions use the service role / table owner. RLS is
-- ENABLE rather than FORCE, so both continue to bypass it. Confirm from the
-- application side after deploying, not only from these catalogue queries:
--   - Express API returns data for an AP_USER session.
--   - fetch-cgc-data returns data for an operations session.
--   - fetch-cgc-data returns only the caller's own rows for a DRIVER session.
--
-- EXPECTED: true for the service role.
SELECT has_table_privilege('service_role', 'public."Invoice"', 'SELECT') AS service_role_can_read_invoice;
