import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkInvoices() {
  const invoices = await prisma.invoice.findMany({
    take: 5,
    orderBy: { receivedAt: 'desc' },
  });
  console.log(JSON.stringify(invoices, null, 2));
  await prisma.$disconnect();
}

checkInvoices();
