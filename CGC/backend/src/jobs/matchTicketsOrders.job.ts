import cron from 'node-cron';
import { prisma } from '../db/prisma.js';

export const startMatchTicketsOrdersJob = () => {
  // TODO: Change to '0 23 * * *' (11 PM daily) in production.
  // For testing, runs every 5 minutes.
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Cron] Starting Ticket-Order Match Job...');
    try {
      const unlinkedTickets = await prisma.ticket.findMany({
        where: {
          status: 'UNLINKED',
        },
      });

      if (unlinkedTickets.length === 0) {
        console.log('[Cron] No unlinked tickets found.');
        return;
      }

      console.log(`[Cron] Processing ${unlinkedTickets.length} unlinked tickets...`);

      for (const ticket of unlinkedTickets) {
        let matchedOrder = null;

        // Try exact match on PO Number first
        if (ticket.poNumber) {
          matchedOrder = await prisma.order.findFirst({
            where: {
              poNumber: ticket.poNumber,
            },
            orderBy: { orderDate: 'desc' },
          });
        }

        // If no match by PO, try combination of Date, Supplier, Material, Quantity
        if (!matchedOrder && ticket.ticketDate && ticket.supplierId && ticket.material && ticket.quantity) {
          const dateStart = new Date(ticket.ticketDate);
          dateStart.setDate(dateStart.getDate() - 2); // 2 days before
          
          const dateEnd = new Date(ticket.ticketDate);
          dateEnd.setDate(dateEnd.getDate() + 2); // 2 days after

          matchedOrder = await prisma.order.findFirst({
            where: {
              supplierId: ticket.supplierId,
              product: {
                contains: ticket.material,
                mode: 'insensitive',
              },
              deliveryDate: {
                gte: dateStart,
                lte: dateEnd,
              },
              // For decimal comparison, we might need raw query or just exact match for now
              quantity: ticket.quantity,
            },
            orderBy: { orderDate: 'desc' },
          });
        }

        if (matchedOrder) {
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              linkedOrderId: matchedOrder.id,
              status: 'LINKED',
              linkMethod: 'AUTO',
            },
          });
          console.log(`[Cron] Automatically linked Ticket ${ticket.id} to Order ${matchedOrder.id}`);
        } else {
          console.log(`[Cron] No matching order found for Ticket ${ticket.id}`);
        }
      }

      console.log('[Cron] Ticket-Order Match Job completed.');
    } catch (error) {
      console.error('[Cron] Ticket-Order Match Job failed:', error);
    }
  });
};
