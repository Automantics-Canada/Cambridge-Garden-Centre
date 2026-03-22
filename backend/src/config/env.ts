import dotenv from 'dotenv';

dotenv.config();

if(!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
}

if(!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
}

export const env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    port: Number(process.env.PORT) || 3000,
}