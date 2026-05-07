import { prisma } from '../src/db/prisma.js';

async function checkOrder() {
  const order = await prisma.order.findUnique({
    where: { id: '030d3935-9c79-462c-9ab8-9b95c2cfe85b' }
  });
  console.log(JSON.stringify(order, null, 2));
}

checkOrder().catch(console.error).finally(() => prisma.$disconnect());
