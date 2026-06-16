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
                if (!ticket.driverId) {
                    // Cleanup any existing auto-matches for non-driver tickets
                    if (ticket.status === 'LINKED' && ticket.linkMethod === 'AUTO') {
                        console.log(`[Cron] Unlinking Ticket ${ticket.id} because it has no driverId and was auto-linked.`);
                        await prisma.ticketOrderMatch.deleteMany({
                            where: {
                                ticketId: ticket.id,
                                matchMethod: { in: ['AUTO_PO', 'AUTO_FALLBACK', 'AUTO_DRIVER_ASSIGNED'] }
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
                let matchingOrders = [];
                let matchMethod = 'AUTO_PO';
                // 1. PO matching (Absolute Priority) - restrict to orders assigned to this driver
                // Ensure PO is exactly 6 digits as per requirements
                if (ticket.poNumber && /^\d{6}$/.test(ticket.poNumber)) {
                    const allMatchingOrders = await prisma.order.findMany({
                        where: {
                            poNumber: ticket.poNumber,
                            driverId: ticket.driverId, // MUST be assigned to this driver
                        },
                        orderBy: { orderDate: 'desc' },
                    });
                    if (allMatchingOrders.length > 1) {
                        if (ticket.status !== 'UNLINKED' || ticket.linkedOrderId !== null || ticket.linkMethod !== null) {
                            console.log(`[Cron] Multiple orders (${allMatchingOrders.length}) found for PO ${ticket.poNumber} assigned to driver ${ticket.driverId}. Cleaning up auto-links for Ticket ${ticket.id}.`);
                            await prisma.ticketOrderMatch.deleteMany({
                                where: {
                                    ticketId: ticket.id,
                                    matchMethod: { in: ['AUTO_PO', 'AUTO_DRIVER_ASSIGNED'] }
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
                        matchMethod = 'AUTO_PO';
                    }
                }
                else if (ticket.poNumber) {
                    console.log(`[Cron] Ticket ${ticket.id} has invalid PO format: ${ticket.poNumber}. Skipping PO matching.`);
                }
                // 2. Fallback matching - match to driver's current active delivery order
                if (matchingOrders.length === 0) {
                    const activeDeliveries = await prisma.delivery.findMany({
                        where: {
                            driverId: ticket.driverId,
                            status: { notIn: ['DELIVERED', 'CANCELLED'] },
                        },
                        orderBy: { priority: 'asc' },
                        include: { order: true },
                    });
                    if (activeDeliveries.length > 0) {
                        matchingOrders = [activeDeliveries[0].order];
                        matchMethod = 'AUTO_DRIVER_ASSIGNED';
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
                                matchMethod: matchMethod,
                            }
                        });
                        await prisma.ticket.update({
                            where: { id: ticket.id },
                            data: { linkedOrderId: order.id, status: 'LINKED', linkMethod: 'AUTO' },
                        });
                        console.log(`[Cron] Automatically linked Ticket ${ticket.id} to driver-assigned order ${order.id} (method: ${matchMethod}).`);
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