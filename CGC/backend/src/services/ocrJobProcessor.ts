import { prisma } from '../db/prisma.js';
import {
  OcrJobStatus,
  TicketStatus,
  OcrJobType,
} from '@prisma/client';
import { InvoiceService } from '../modules/invoices/invoice.service.js';
import { ExtractionError } from './extraction/extraction.service.js';
import { shouldRunWorkersInProcess } from '../workers/runtime.js';

/**
 * Process a single OCR job asynchronously
 * This function handles the entire pipeline:
 * 1. Read the document with the extraction service
 * 2. Write the extracted fields back
 * 3. Auto-link to orders if PO number matches
 * 4. Update ticket and job status
 */
/**
 * How many times a document is retried before a person has to look at it.
 *
 * Model APIs fail transiently — rate limits, upstream faults. Retrying forever
 * would hide a document that can never be read (a blank scan, a corrupt upload)
 * behind an endlessly retried job, so failures stop being retried and start
 * being reported.
 *
 * Which failures are worth retrying is the extraction provider's judgement, not
 * a guess made here: see `ExtractionError.retryable`.
 */
export const MAX_OCR_ATTEMPTS = 4;

/** Backoff before the next attempt: 2, 8, 32 minutes. */
function backoffMs(attempts: number): number {
  return 2 * 60 * 1000 * Math.pow(4, Math.max(0, attempts - 1));
}

export async function processOcrJob(jobId: string): Promise<void> {
  try {
    const ocrJob = await prisma.ocrJob.findUnique({
      where: { id: jobId },
      include: { ticket: true, invoice: true },
    });

    if (!ocrJob) {
      console.error(`OCR Job not found: ${jobId}`);
      return;
    }

    if (!ocrJob.ticket && !ocrJob.invoice) {
      console.error(`No target entity (ticket/invoice) found for OCR Job: ${jobId}`);
      return;
    }

    // Update job status to PROCESSING and count the attempt. Counting here
    // rather than on failure means a job that crashes the process mid-run still
    // burns an attempt, so a document that reliably kills the worker cannot
    // retry indefinitely.
    await prisma.ocrJob.update({
      where: { id: jobId },
      data: {
        status: OcrJobStatus.PROCESSING,
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    const targetId = ocrJob.ticket?.id || ocrJob.invoice?.id;
    console.log(`[OCR] Processing job ${jobId} for entity ${targetId}`);

    if (ocrJob.type === OcrJobType.TICKET && ocrJob.ticket) {
      console.log(`[OCR] Processing Ticket OCR for: ${ocrJob.ticket.id}`);
      // Delegate to TicketService to ensure consistent logic (junction table, etc.)
      const { TicketService } = await import('../modules/tickets/ticket.service.js');
      await TicketService.processTicketOcr(ocrJob.ticket.id);
    } else if (ocrJob.type === OcrJobType.INVOICE && ocrJob.invoice) {
        console.log(`[OCR] Processing Invoice OCR for: ${ocrJob.invoice.id}`);
        // Delegate to InvoiceService
        await InvoiceService.processInvoiceOcr(ocrJob.invoice.id);
        // InvoiceService already updates the ocrJob status inside its method
    }

    console.log(`[OCR] Successfully processed job ${jobId}`);
  } catch (error: any) {
    console.error(`[OCR] Error processing job ${jobId}:`, error?.message);

    // Retry a bounded number of times, then leave it FAILED for a human.
    try {
      const current = await prisma.ocrJob.findUnique({
        where: { id: jobId },
        select: { attempts: true },
      });
      const attempts = current?.attempts ?? MAX_OCR_ATTEMPTS;
      // A failure the provider calls permanent — an unreadable file type, a
      // refusal, a rejected request — fails identically every time. Retrying it
      // three more times over an hour only delays the person who has to look.
      const isPermanent = error instanceof ExtractionError && !error.retryable;
      const willRetry = !isPermanent && attempts < MAX_OCR_ATTEMPTS;

      await prisma.ocrJob.update({
        where: { id: jobId },
        data: {
          status: willRetry ? OcrJobStatus.PENDING : OcrJobStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: error?.message || 'Unknown error',
          nextAttemptAt: willRetry ? new Date(Date.now() + backoffMs(attempts)) : null,
        },
      });

      console.error(
        willRetry
          ? `[OCR] Job ${jobId} failed (attempt ${attempts}/${MAX_OCR_ATTEMPTS}); retrying later.`
          : isPermanent
            ? `[OCR] Job ${jobId} cannot be processed: ${error?.message}. Needs a human.`
            : `[OCR] Job ${jobId} failed permanently after ${attempts} attempts. Needs a human.`
      );
    } catch (updateError) {
      console.error(`[OCR] Failed to update job status for ${jobId}:`, updateError);
    }
  }
}

let isProcessingPending = false;

/**
 * Process all pending OCR jobs
 * This can be called periodically by a cron job or triggered manually
 */
export async function processPendingOcrJobs(): Promise<number> {
  if (isProcessingPending) {
    console.log('[OCR] Pending jobs processing already in progress. Skipping...');
    return 0;
  }

  try {
    isProcessingPending = true;
    const now = new Date();
    const pendingJobs = await prisma.ocrJob.findMany({
      where: {
        status: OcrJobStatus.PENDING,
        // A job awaiting its backoff window is not due yet. NULL means it has
        // never failed, so it is due immediately.
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { nextAttemptAt: { sort: 'asc', nulls: 'first' } },
      // Bounded so one sweep cannot occupy the process indefinitely; the next
      // tick picks up the rest.
      take: 25,
    });

    console.log(`[OCR] Found ${pendingJobs.length} due OCR jobs`);

    // Process each job
    for (const job of pendingJobs) {
      await processOcrJob(job.id);
    }

    return pendingJobs.length;
  } catch (error) {
    console.error('[OCR] Error processing pending jobs:', error);
    return 0;
  } finally {
    isProcessingPending = false;
  }
}

/**
 * Documents that have exhausted their retries and need a person.
 *
 * Without this, a permanently failed OCR job is invisible: the ticket or
 * invoice simply never gains its extracted fields, and nothing distinguishes
 * "not processed yet" from "will never be processed".
 */
export async function getStuckOcrJobs() {
  const [count, jobs] = await Promise.all([
    prisma.ocrJob.count({ where: { status: OcrJobStatus.FAILED } }),
    prisma.ocrJob.findMany({
      where: { status: OcrJobStatus.FAILED },
      orderBy: { finishedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        type: true,
        attempts: true,
        errorMessage: true,
        finishedAt: true,
        ticketId: true,
        invoiceId: true,
      },
    }),
  ]);

  return { count, jobs };
}

/**
 * Trigger OCR processing for a specific ticket (async, non-blocking)
 * This is called automatically when a ticket is created
 */
export function triggerOcrProcessing(jobId: string): void {
  // With the workers split out, the API process must not start OCR itself —
  // that would put the CPU-bound page rasterisation back on the request loop,
  // which is the whole thing the split avoids. The job row is already PENDING,
  // so the worker picks it up on its next sweep.
  if (!shouldRunWorkersInProcess()) return;

  // Use setImmediate to process in next event loop iteration without blocking
  setImmediate(async () => {
    await processOcrJob(jobId).catch((error) => {
      console.error(`[OCR] Unhandled error in background OCR processing for job ${jobId}:`, error);
    });
  });
}
