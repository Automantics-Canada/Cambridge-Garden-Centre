import { PrismaClient } from "@prisma/client";
const globalForPrisma = global;
export const prisma = globalForPrisma.Prisma ||
    new PrismaClient({
        log: ['query', 'error', 'warn', 'info'],
    });
if (process.env.NODE_ENV !== 'production')
    globalForPrisma.Prisma = prisma;
//# sourceMappingURL=prisma.js.map