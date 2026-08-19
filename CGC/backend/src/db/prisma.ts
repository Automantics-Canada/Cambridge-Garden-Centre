import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { Prisma?: PrismaClient };

export const prisma = 
    globalForPrisma.Prisma ||
    new PrismaClient({
        // Query-level logging is useful locally but adds noise and work to every
        // production request. Errors and warnings remain visible everywhere.
        log: process.env.NODE_ENV === 'development'
            ? ['query', 'error', 'warn', 'info']
            : ['error', 'warn'],
    });

if (process.env.NODE_ENV !== 'production') globalForPrisma.Prisma = prisma;
