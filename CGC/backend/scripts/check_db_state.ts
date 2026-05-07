import { prisma } from '../src/db/prisma.js';

async function checkDb() {
  const suppliers = await prisma.supplier.findMany();
  const rates = await prisma.negotiatedRate.findMany();
  console.log('Suppliers:', JSON.stringify(suppliers, null, 2));
  console.log('Rates:', JSON.stringify(rates, null, 2));
}

checkDb();
