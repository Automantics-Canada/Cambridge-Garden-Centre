import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const count = await prisma.order.count();
  console.log('Total orders in DB:', count);
  const latest = await prisma.order.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' }
  });
  console.log('Latest 10 orders:', latest.map(o => ({
    spruceOrderId: o.spruceOrderId,
    customerName: o.customerName,
    createdAt: o.createdAt,
    orderDate: o.orderDate
  })));
  await prisma.$disconnect();
}

run();
