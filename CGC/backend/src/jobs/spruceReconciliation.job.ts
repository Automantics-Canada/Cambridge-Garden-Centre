import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
// Import OCR services (mocked here based on existing structure)
import { extractTextFromLocalImage } from '../services/ocr.service.js';

export const startSpruceReconciliationJob = () => {
  // Run every night at 23:59
  cron.schedule('59 23 * * *', async () => {
    console.log('[Cron] Starting Spruce EOD Reconciliation Job...');
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Find all delivered deliveries for today
      const deliveries = await prisma.delivery.findMany({
        where: {
          status: 'DELIVERED',
          completedAt: { gte: today }
        },
        include: {
          order: {
            include: { tickets: true }
          }
        }
      });

      console.log(`[Cron] Found ${deliveries.length} completed deliveries to reconcile.`);

      for (const delivery of deliveries) {
        // Ideally fetch Spruce CSV row here and match.
        // For this implementation plan, we will just simulate the OCR match process.
        let matchFound = false;
        
        if (delivery.pickupPhotoUrl) {
          console.log(`[Cron] Running OCR on pickup photo for delivery ${delivery.id}`);
          try {
             // const ocrResult = await extractTextFromLocalImage(delivery.pickupPhotoUrl);
             // matchFound = ocrResult.confidence > 0.8;
             matchFound = true; // Simulated
          } catch (e) {
             console.error(`OCR failed for delivery ${delivery.id}`, e);
          }
        }

        // Update related tickets
        if (matchFound && delivery.order.tickets.length > 0) {
          for (const ticket of delivery.order.tickets) {
            await prisma.ticket.update({
              where: { id: ticket.id },
              data: { spruceMatched: true }
            });
            console.log(`[Cron] Marked Ticket ${ticket.id} as Spruce Matched.`);
          }
        } else if (!matchFound) {
          console.log(`[Cron] Discrepancy: Delivery ${delivery.id} could not be matched with Spruce actuals.`);
          // Create an audit log or flag
          await prisma.auditLog.create({
            data: {
              entityType: 'ORDER',
              entityId: delivery.orderId,
              actionType: 'SYSTEM_CONFIG_CHANGE', // Reusing enum for now, or could add SPRUCE_MISMATCH
              details: { error: 'Spruce mismatch or missing ticket in EOD run', deliveryId: delivery.id }
            }
          });
        }
      }
      
      console.log('[Cron] Spruce EOD Reconciliation Job completed.');
    } catch (error) {
      console.error('[Cron] Spruce EOD Reconciliation Job failed:', error);
    }
  });
};
