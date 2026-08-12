/**
 * Applies the public-schema privilege lockdown through the application's own
 * database connection, for environments where the Supabase migration chain is
 * not the delivery mechanism.
 *
 * This must stay behaviourally identical to
 * supabase/migrations/20260812150000_lock_down_public_schema.sql. Both revoke
 * privileges only; neither creates, alters or drops an application object, and
 * neither touches business data.
 *
 * Default privileges are recorded per grantor role, so a bare
 * `ALTER DEFAULT PRIVILEGES ... REVOKE` silently does nothing unless the
 * connected role happens to be the same role that issued the original GRANT.
 * The DO block below reads the real grantors out of pg_default_acl instead of
 * assuming, and reports any role it lacks membership in rather than failing
 * silently.
 *
 * Run against staging first, and verify with
 * supabase/verification/lockdown-verification.sql afterwards.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const statements: string[] = [
  `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;`,
  `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;`,
  `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;`,
  `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;`,
  `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;`,
  `DO $$
   DECLARE
     grantor_name text;
   BEGIN
     FOR grantor_name IN
       SELECT DISTINCT pg_get_userbyid(d.defaclrole)
       FROM pg_default_acl d
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
       WHERE n.nspname = 'public'
     LOOP
       BEGIN
         EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated', grantor_name);
         EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated', grantor_name);
         EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated', grantor_name);
         RAISE NOTICE 'Revoked anon/authenticated default privileges granted by role %', grantor_name;
       EXCEPTION
         WHEN insufficient_privilege THEN
           RAISE WARNING 'Could not alter default privileges for grantor role %. Re-run as a member of that role.', grantor_name;
       END;
     END LOOP;
   END
   $$;`,
  `DO $$
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
         EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', table_record.schema_name, table_record.table_name);
       EXCEPTION
         WHEN insufficient_privilege THEN
           RAISE WARNING 'Could not enable RLS on %.% (not the owner).', table_record.schema_name, table_record.table_name;
       END;
     END LOOP;
   END
   $$;`,
];

async function main() {
  console.log('Locking down public schema privileges...');

  for (const statement of statements) {
    const label = statement.split('\n')[0]!.trim();
    console.log(`Executing: ${label}`);
    await prisma.$executeRawUnsafe(statement);
  }

  const remaining = await prisma.$queryRawUnsafe<Array<{ grantee: string; count: bigint }>>(
    `SELECT grantee, count(*)::bigint AS count
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      GROUP BY grantee`
  );

  if (remaining.length === 0) {
    console.log('Verified: anon, authenticated and PUBLIC hold no table grants in public.');
  } else {
    console.warn('Residual grants remain:', remaining);
    process.exitCode = 1;
  }

  console.log('Run supabase/verification/lockdown-verification.sql for the full check.');
}

main()
  .catch((error) => {
    console.error('Privilege lockdown failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
