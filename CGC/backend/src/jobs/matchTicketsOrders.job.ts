import cron from 'node-cron';
import { prisma } from '../db/prisma.js';

export const startMatchTicketsOrdersJob = () => {
  // Runs every minute for real-time matching
  cron.schedule('* * * * *', async () => {
    console.log('[Cron] Starting Ticket-Order Match Job...');
    try {
      const unlinkedTickets = await prisma.ticket.findMany({
        where: {
          OR: [
            { status: 'UNLINKED' },
            { 
              status: 'LINKED',
              orderMatches: { none: {} }
            }
          ]
        },
      });

      if (unlinkedTickets.length === 0) {
        console.log('[Cron] No unlinked or inconsistent tickets found.');
        return;
      }

      console.log(`[Cron] Processing ${unlinkedTickets.length} unlinked tickets...`);

      for (const ticket of unlinkedTickets) {
        let matchingOrders: any[] = [];

        // 1. PO matching (Absolute Priority)
        if (ticket.poNumber) {
          matchingOrders = await prisma.order.findMany({
            where: {
              poNumber: ticket.poNumber,
            },
            orderBy: { orderDate: 'desc' },
          });
        }

        // 2. Fallback to Date/Supplier/Material/Quantity matching if no PO match
        if (matchingOrders.length === 0 && ticket.ticketDate && ticket.supplierId && ticket.material && ticket.quantity) {
          const dateStart = new Date(ticket.ticketDate);
          dateStart.setDate(dateStart.getDate() - 2);
          
          const dateEnd = new Date(ticket.ticketDate);
          dateEnd.setDate(dateEnd.getDate() + 2);

          const fallbackOrder = await prisma.order.findFirst({
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
              quantity: ticket.quantity,
            },
            orderBy: { orderDate: 'desc' },
          });

          if (fallbackOrder) {
            matchingOrders = [fallbackOrder];
          }
        }

        if (matchingOrders.length > 0) {
          console.log(`[Cron] Ticket ${ticket.id} matched with ${matchingOrders.length} orders.`);

          for (const order of matchingOrders) {
            // Create junction table entry (deduplicated by @unique constraint or manual check)
            try {
              await prisma.ticketOrderMatch.upsert({
                where: {
                  ticketId_orderId: {
                    ticketId: ticket.id,
                    orderId: order.id,
                  }
                },
                update: {}, // No update needed if exists
                create: {
                  ticketId: ticket.id,
                  orderId: order.id,
                  matchMethod: ticket.poNumber === order.poNumber ? 'AUTO_PO' : 'AUTO_FALLBACK',
                }
              });
            } catch (err) {
              console.error(`[Cron] Error creating match for Ticket ${ticket.id} and Order ${order.id}:`, err);
            }
          }

          // Update ticket status
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              linkedOrderId: matchingOrders[0].id, // Backward compatibility
              status: 'LINKED',
              linkMethod: 'AUTO',
            },
          });
          
          console.log(`[Cron] Automatically linked Ticket ${ticket.id} to ${matchingOrders.length} orders.`);
        } else {
          // No match found
        }
      }

      console.log('[Cron] Ticket-Order Match Job completed.');
    } catch (error) {
      console.error('[Cron] Ticket-Order Match Job failed:', error);
    }
  });
};

