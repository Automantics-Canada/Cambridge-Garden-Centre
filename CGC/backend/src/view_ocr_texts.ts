import { prisma } from './db/prisma.js';

async function main() {
  const ids = [
    'e58ff020-0cce-4add-9b40-19b438e46810',
    '056fe54d-376d-4c12-a6a7-60d3e31b8d5b',
    '66011fd7-f35e-41c0-853c-69de835cb368'
  ];

  const tickets = await prisma.ticket.findMany({
    where: { id: { in: ids } },
  });

  for (const t of tickets) {
    console.log(`Ticket ID: ${t.id}`);
    console.log(`  RawText: "${t.ocrRawText.replace(/\n/g, '\\n')}"`);
    console.log(`  ImageUrl: ${t.imageUrl}`);
    console.log('---------------------------');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
