import { prisma } from '../src/db/prisma.js';

async function createMatch() {
  const ticket = await prisma.ticket.findFirst();
  const order = await prisma.order.findFirst();
  
  if (!ticket || !order) {
    console.log('No ticket or order found');
    return;
  }

  console.log(`Creating match for Ticket ${ticket.id} and Order ${order.id}`);
  
  await prisma.ticketOrderMatch.upsert({
    where: {
      ticketId_orderId: {
        ticketId: ticket.id,
        orderId: order.id,
      }
    },
    update: {},
    create: {
      ticketId: ticket.id,
      orderId: order.id,
      matchMethod: 'TEST',
    }
  });
  
  const matches = await prisma.ticketOrderMatch.findMany();
  console.log(`Now found ${matches.length} matches.`);
}

createMatch().catch(console.error).finally(() => prisma.$disconnect());
