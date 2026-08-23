import { prisma } from '../db/prisma.js';
import {
  OcrJobStatus,
  TicketStatus,
  OcrJobType,
} from '@prisma/client';
import { InvoiceService } from '../modules/invoices/invoice.service.js';
import { shouldRunWorkersInProcess } from '../workers/runtime.js';

/**
 * Process a single OCR job asynchronously
 * This function handles the entire OCR pipeline:
 * 1. Extract text from image using AWS Textract
 * 2. Parse extracted data
 * 3. Auto-link to orders if PO number matches
 * 4. Update ticket and job status
 */
/**
 * How many times a document is retried before a person has to look at it.
 *
 * Textract fails transiently, and so does the network under it. Retrying forever
 * would hide a document that can never be read (a blank scan, a corrupt upload)
 * behind an endlessly retried job, so failures stop being retried and start
 * being reported.
 *
 * Note what is *not* retried: a document that was read but not confidently. That
 * is NEEDS_REVIEW, it is terminal, and it never re-enters this loop. In
 * particular a deployment with no Groq key does not produce a retry storm — each
 * such document is held for a person on its first pass and never queued again.
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

    // Atomically claim the due PENDING row. Multiple API triggers, worker ticks,
    // or replicas may race on the same job; exactly one is allowed past here.
    const now = new Date();
    const claimed = await prisma.ocrJob.updateMany({
      where: {
        id: jobId,
        status: OcrJobStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: OcrJobStatus.PROCESSING,
        startedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      console.log(`[OCR] Skipped job ${jobId}; it is not due and pending`);
      return;
    }

    const targetId = ocrJob.ticket?.id || ocrJob.invoice?.id;
    console.log(`[OCR] Processing job ${jobId} for entity ${targetId}`);

    if (ocrJob.type === OcrJobType.TICKET && ocrJob.ticket) {
      console.log(`[OCR] Processing Ticket OCR for: ${ocrJob.ticket.id}`);
      // Delegate to TicketService to ensure consistent logic (junction table, etc.)
      const { TicketService } = await import('../modules/tickets/ticket.service.js');
      await TicketService.processTicketOcr(ocrJob.ticket.id, jobId);
    } else if (ocrJob.type === OcrJobType.INVOICE && ocrJob.invoice) {
        console.log(`[OCR] Processing Invoice OCR for: ${ocrJob.invoice.id}`);
        // Delegate to InvoiceService
        await InvoiceService.processInvoiceOcr(ocrJob.invoice.id, jobId);
        // InvoiceService already updates the ocrJob status inside its method
    }

    // The delegated service has already set the job's terminal status —
    // COMPLETED when the extraction validated, NEEDS_REVIEW when it produced a
    // usable candidate that a person has to confirm.
    const finished = await prisma.ocrJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    console.log(
      `[OCR] Finished job ${jobId} with status ${finished?.status ?? 'UNKNOWN'}`
    );
  } catch (error: any) {
    console.error(`[OCR] Error processing job ${jobId}:`, error?.message);

    // Retry a bounded number of times, then leave it FAILED for a human.
    try {
      const current = await prisma.ocrJob.findUnique({
        where: { id: jobId },
        select: { attempts: true },
      });
      const attempts = current?.attempts ?? MAX_OCR_ATTEMPTS;
      const willRetry = attempts < MAX_OCR_ATTEMPTS;

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
 * Documents that are not going to finish on their own.
 *
 * Two distinct populations, reported separately because they need different
 * things from a person:
 *
 *   FAILED        could not be read at all, retries exhausted. Someone has to
 *                 look at the file itself — a blank scan, a corrupt upload, a
 *                 credential problem.
 *   NEEDS_REVIEW  was read, and the result is usable, but a required field is
 *                 unresolved or a value came from the fallback reader. Someone
 *                 has to confirm it on the review desk.
 *
 * Collapsing the two would either bury a readable document in the failure
 * report or claim a genuinely broken one is merely awaiting review.
 */
const STUCK_JOB_SELECT = {
  id: true,
  type: true,
  status: true,
  attempts: true,
  errorMessage: true,
  reviewReasons: true,
  fallbackUsed: true,
  structuredModel: true,
  extractionConfidence: true,
  finishedAt: true,
  ticketId: true,
  invoiceId: true,
} as const;

export async function getStuckOcrJobs() {
  const [count, jobs, needsReviewCount, needsReview] = await Promise.all([
    prisma.ocrJob.count({ where: { status: OcrJobStatus.FAILED } }),
    prisma.ocrJob.findMany({
      where: { status: OcrJobStatus.FAILED },
      orderBy: { finishedAt: 'desc' },
      take: 20,
      select: STUCK_JOB_SELECT,
    }),
    prisma.ocrJob.count({ where: { status: OcrJobStatus.NEEDS_REVIEW } }),
    prisma.ocrJob.findMany({
      where: { status: OcrJobStatus.NEEDS_REVIEW },
      orderBy: { finishedAt: 'desc' },
      take: 20,
      select: STUCK_JOB_SELECT,
    }),
  ]);

  return { count, jobs, needsReviewCount, needsReview };
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
