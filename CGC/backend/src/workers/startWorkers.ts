import { GmailService } from '../services/gmail.service.js';
import { processPendingOcrJobs } from '../services/ocrJobProcessor.js';
import { startMatchTicketsOrdersJob } from '../jobs/matchTicketsOrders.job.js';
import { startWorkerHeartbeat, type WorkerProcessMode } from './heartbeat.js';

/**
 * Starts every background worker and returns a stop function.
 *
 * Extracted so the API process and the standalone worker process start exactly
 * the same set. When these were inline in `server.ts` there was no way to run
 * them anywhere else without duplicating the wiring, and duplicated wiring
 * drifts.
 *
 * `mode` records which process this is. It is written by the heartbeat so the
 * health endpoint can tell a live standalone worker from an API that is quietly
 * still running the workers itself, and it defaults to `inline` so the existing
 * call in `server.ts` needs no change.
 */
export function startWorkers(mode: WorkerProcessMode = 'inline'): () => void {
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

  // Last, so it only starts recording once everything above is wired. A
  // heartbeat from a process that then failed to start its pollers would be
  // worse than none: it would report a healthy worker doing nothing.
  const stopHeartbeat = startWorkerHeartbeat(mode);

  return () => {
    clearInterval(gmailTimer);
    clearInterval(ocrTimer);
    stopHeartbeat();
  };
}
