import { prisma } from '../src/db/prisma.js';

async function verifyFix() {
  const tickets = await prisma.ticket.findMany({
    where: { status: 'LINKED' },
    include: { orderMatches: true }
  });

  for (const ticket of tickets) {
    if (ticket.poNumber) {
      const matchingOrders = await prisma.order.findMany({
        where: { poNumber: ticket.poNumber }
      });

      for (const order of matchingOrders) {
        await prisma.ticketOrderMatch.upsert({
          where: { ticketId_orderId: { ticketId: ticket.id, orderId: order.id } },
          update: {},
          create: { ticketId: ticket.id, orderId: order.id, matchMethod: 'AUTO_REPAIR' }
        });
        console.log(`Linked Ticket ${ticket.ticketNumber} to Order ${order.spruceOrderId}`);
      }
    }
  }
}

verifyFix().catch(console.error).finally(() => prisma.$disconnect());
