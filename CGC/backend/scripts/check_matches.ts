import { prisma } from '../src/db/prisma.js';

async function checkMatches() {
  const matches = await prisma.ticketOrderMatch.findMany({
    include: { ticket: true, order: true }
  });
  console.log(`Found ${matches.length} matches.`);
  matches.forEach(m => console.log(`Ticket ${m.ticket.ticketNumber} -> Order ${m.order.spruceOrderId} (${m.matchMethod})`));
}

checkMatches().catch(console.error).finally(() => prisma.$disconnect());
