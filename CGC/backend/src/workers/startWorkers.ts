import { GmailService } from '../services/gmail.service.js';
import { processPendingOcrJobs } from '../services/ocrJobProcessor.js';
import { startMatchTicketsOrdersJob } from '../jobs/matchTicketsOrders.job.js';

/**
 * Starts every background worker and returns a stop function.
 *
 * Extracted so the API process and the standalone worker process start exactly
 * the same set. When these were inline in `server.ts` there was no way to run
 * them anywhere else without duplicating the wiring, and duplicated wiring
 * drifts.
 */
export function startWorkers(): () => void {
  const GMAIL_POLL_INTERVAL = 60 * 1000;
  const OCR_POLL_INTERVAL = 2 * 60 * 1000;

  console.log(`📧 Gmail sync active every ${GMAIL_POLL_INTERVAL / 1000}s.`);
  const gmailTimer = setInterval(() => {
    GmailService.pollInvoices().catch(err => console.error('[Gmail] Poll failed:', err));
  }, GMAIL_POLL_INTERVAL);
  GmailService.pollInvoices().catch(err => console.error('[Gmail] Initial poll failed:', err));

  console.log(`🔍 OCR worker active every ${OCR_POLL_INTERVAL / 1000}s.`);
  const ocrTimer = setInterval(() => {
    processPendingOcrJobs().catch(err => console.error('[OCR] Sweep failed:', err));
  }, OCR_POLL_INTERVAL);
  processPendingOcrJobs().catch(err => console.error('[OCR] Initial sweep failed:', err));

  startMatchTicketsOrdersJob();

  return () => {
    clearInterval(gmailTimer);
    clearInterval(ocrTimer);
  };
}
