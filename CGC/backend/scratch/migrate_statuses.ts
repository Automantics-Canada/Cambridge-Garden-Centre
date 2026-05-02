import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function migrate() {
  console.log('Migrating legacy statuses...');
  const assigned = await prisma.delivery.updateMany({
    where: { status: 'ASSIGNED' as any },
    data: { status: 'PLACED' as any }
  });
  console.log(`Updated ${assigned.count} ASSIGNED -> PLACED`);

  const pickedUp = await prisma.delivery.updateMany({
    where: { status: 'PICKED_UP' as any },
    data: { status: 'IN_TRANSIT' as any }
  });
  console.log(`Updated ${pickedUp.count} PICKED_UP -> IN_TRANSIT`);
  
  await prisma.$disconnect();
}

migrate();
