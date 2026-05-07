import { prisma } from '../src/db/prisma.js';

async function checkTicket() {
  const ticket = await prisma.ticket.findFirst({
    where: { ticketNumber: '55432' },
    include: {
      orderMatches: {
        include: { order: true }
      }
    }
  });
  console.log(JSON.stringify(ticket, null, 2));
}

checkTicket().catch(console.error).finally(() => prisma.$disconnect());
