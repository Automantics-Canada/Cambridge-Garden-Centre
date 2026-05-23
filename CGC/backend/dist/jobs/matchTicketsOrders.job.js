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
                        { linkMethod: 'AUTO' }, // Re-verify auto-links to ensure they remain valid (single order)
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
                let matchingOrders = [];
                // 1. PO matching (Absolute Priority)
                // Ensure PO is exactly 6 digits as per requirements
                if (ticket.poNumber && /^\d{6}$/.test(ticket.poNumber)) {
                    const allMatchingOrders = await prisma.order.findMany({
                        where: {
                            poNumber: ticket.poNumber,
                        },
                        orderBy: { orderDate: 'desc' },
                    });
                    // If multiple orders found for the same PO, do NOT auto-link
                    // AND cleanup any existing auto-matches (in case they were linked during incremental import)
                    if (allMatchingOrders.length > 1) {
                        if (ticket.status !== 'UNLINKED' || ticket.linkedOrderId !== null || ticket.linkMethod !== null) {
                            console.log(`[Cron] Multiple orders (${allMatchingOrders.length}) found for PO ${ticket.poNumber}. Cleaning up auto-links for Ticket ${ticket.id}.`);
                            await prisma.ticketOrderMatch.deleteMany({
                                where: {
                                    ticketId: ticket.id,
                                    matchMethod: { in: ['AUTO_PO', 'AUTO_FALLBACK'] }
                                }
                            });
                            await prisma.ticket.update({
                                where: { id: ticket.id },
                                data: {
                                    status: 'UNLINKED',
                                    linkedOrderId: null,
                                    linkMethod: null
                                }
                            });
                        }
                        continue;
                    }
                    else if (allMatchingOrders.length === 1) {
                        matchingOrders = [allMatchingOrders[0]];
                    }
                }
                else if (ticket.poNumber) {
                    console.log(`[Cron] Ticket ${ticket.id} has invalid PO format: ${ticket.poNumber}. Skipping PO matching.`);
                }
                // 2. Fallback matching (only if no PO match found and count is 0)
                if (matchingOrders.length === 0 && ticket.ticketDate && ticket.supplierId && ticket.material && ticket.quantity) {
                    // ... (existing fallback logic remains the same, ensuring length === 1)
                    const dateStart = new Date(ticket.ticketDate);
                    dateStart.setDate(dateStart.getDate() - 2);
                    const dateEnd = new Date(ticket.ticketDate);
                    dateEnd.setDate(dateEnd.getDate() + 2);
                    const fallbackOrders = await prisma.order.findMany({
                        where: {
                            supplierId: ticket.supplierId,
                            product: { contains: ticket.material, mode: 'insensitive' },
                            deliveryDate: { gte: dateStart, lte: dateEnd },
                            quantity: ticket.quantity,
                        },
                        orderBy: { orderDate: 'desc' },
                    });
                    if (fallbackOrders.length === 1) {
                        matchingOrders = [fallbackOrders[0]];
                    }
                }
                if (matchingOrders.length === 1) {
                    const order = matchingOrders[0];
                    // Skip if already correctly linked to avoid redundant updates that trigger realtime loops
                    if (ticket.linkedOrderId === order.id && ticket.status === 'LINKED' && ticket.linkMethod === 'AUTO') {
                        continue;
                    }
                    try {
                        await prisma.ticketOrderMatch.upsert({
                            where: { ticketId_orderId: { ticketId: ticket.id, orderId: order.id } },
                            update: {},
                            create: {
                                ticketId: ticket.id,
                                orderId: order.id,
                                matchMethod: ticket.poNumber === order.poNumber ? 'AUTO_PO' : 'AUTO_FALLBACK',
                            }
                        });
                        await prisma.ticket.update({
                            where: { id: ticket.id },
                            data: { linkedOrderId: order.id, status: 'LINKED', linkMethod: 'AUTO' },
                        });
                        console.log(`[Cron] Automatically linked Ticket ${ticket.id} to order ${order.id}.`);
                    }
                    catch (err) {
                        console.error(`[Cron] Error linking Ticket ${ticket.id}:`, err);
                    }
                }
            }
            console.log('[Cron] Ticket-Order Match Job completed.');
        }
        catch (error) {
            console.error('[Cron] Ticket-Order Match Job failed:', error);
        }
    });
};
//# sourceMappingURL=matchTicketsOrders.job.js.map