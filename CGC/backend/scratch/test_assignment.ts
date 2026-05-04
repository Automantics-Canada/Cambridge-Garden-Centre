import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { prisma } from '../src/db/prisma.js';

async function main() {
  // Find a driver with an email
  const driver = await prisma.driver.findFirst({
    where: { email: { not: null } }
  });

  if (!driver) {
    console.log('No driver with email found');
    return;
  }

  // Find an unassigned order
  const order = await prisma.order.findFirst({
    where: { deliveries: { none: {} } }
  });

  if (!order) {
    console.log('No unassigned order found');
    return;
  }

  console.log(`Assigning order ${order.id} to driver ${driver.name} (${driver.email})`);
  
  try {
    const delivery = await DispatchService.assignDriver(order.id, driver.id);
    console.log('Assignment successful:', delivery.id);
  } catch (error) {
    console.error('Assignment failed:', error);
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
