import dotenv from 'dotenv';

dotenv.config();

if(!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
}

if(!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
}


if(!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is required');
}

if(!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
}

if(!process.env.SUPABASE_STORAGE_BUCKET) {
    throw new Error('SUPABASE_STORAGE_BUCKET is required');
}

export const env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL!,
    jwtSecret: process.env.JWT_SECRET!,
    port: Number(process.env.PORT) || 3000,
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET!,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
}