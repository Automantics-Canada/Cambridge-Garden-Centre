import { prisma } from '../src/db/prisma.js';

async function main() {
  const order = await prisma.order.create({
    data: {
      spruceOrderId: 'TEST-' + Date.now(),
      customerName: 'Test Customer',
      buyerType: 'RETAIL',
      product: 'Test Product',
      quantity: '1',
      unit: 'Units',
      orderDate: new Date(),
    }
  });
  console.log('Created order:', order.spruceOrderId);
}

main().catch(console.error).finally(() => prisma.$disconnect());
