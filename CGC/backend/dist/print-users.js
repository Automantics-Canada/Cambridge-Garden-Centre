import { prisma } from './db/prisma.js';
async function main() {
    const users = await prisma.user.findMany();
    console.log(JSON.stringify(users, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
//# sourceMappingURL=print-users.js.map