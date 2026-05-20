import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('⚡ Starting schema privilege grants for Supabase roles...');

  const sqlQueries = [
    // 1. Grant USAGE on public schema to all roles
    `GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;`,
    
    // 2. Grant all privileges on all existing tables/sequences/functions in public schema
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;`,
    `GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO postgres, anon, authenticated, service_role;`,
    
    // 3. Alter default privileges for future tables created in public schema
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;`
  ];

  for (const query of sqlQueries) {
    try {
      console.log(`Executing: ${query}`);
      await prisma.$executeRawUnsafe(query);
    } catch (err: any) {
      console.error(`❌ Error executing query: ${err.message}`);
    }
  }

  console.log('✅ Schema privilege grants completed successfully!');
}

main()
  .catch((err) => {
    console.error('❌ Script failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
