import { prisma } from '../db/prisma.js';
import { extractTextFromLocalImage } from './ocr.service.js';
import {
  OcrJobStatus,
  TicketStatus,
} from '@prisma/client';

/**
 * Process a single OCR job asynchronously
 * This function handles the entire OCR pipeline:
 * 1. Extract text from image using AWS Textract
 * 2. Parse extracted data
 * 3. Auto-link to orders if PO number matches
 * 4. Update ticket and job status
 */
export async function processOcrJob(jobId: string): Promise<void> {
  try {
    const ocrJob = await prisma.ocrJob.findUnique({
      where: { id: jobId },
      include: { ticket: true },
    });

    if (!ocrJob) {
      console.error(`OCR Job not found: ${jobId}`);
      return;
    }

    if (!ocrJob.ticket) {
      console.error(`Ticket not found for OCR Job: ${jobId}`);
      return;
    }

    // Update job status to PROCESSING
    await prisma.ocrJob.update({
      where: { id: jobId },
      data: {
        status: OcrJobStatus.PROCESSING,
        startedAt: new Date(),
      },
    });

    console.log(`[OCR] Processing job ${jobId} for ticket ${ocrJob.ticket.id}`);

    // Extract text from image using AWS Textract
    const extracted = await extractTextFromLocalImage(ocrJob.ticket.imageUrl);

    console.log(
      `[Textract Only] OCR extraction completed for ticket ${ocrJob.ticket.id}`
    );

    // Determine final PO number (prefer OCR extraction over manual input)
    const finalPoNumber = extracted.poNumber || ocrJob.ticket.poNumber;

    let linkedOrderId = null;
    let ticketStatus: TicketStatus = TicketStatus.UNLINKED;
    let linkMethod = null;

    // Try to auto-link to an order if we have a PO number
    if (finalPoNumber) {
      const matchingOrders = await prisma.order.findMany({
        where: { poNumber: finalPoNumber },
      });

      // Auto-link only if exactly one match is found
      if (matchingOrders.length === 1) {
        const matchingOrder = matchingOrders[0];
        if (matchingOrder) {
          linkedOrderId = matchingOrder.id;
          ticketStatus = TicketStatus.LINKED;
          linkMethod = 'AUTO';
          console.log(
            `[OCR] Auto-linked ticket ${ocrJob.ticket.id} to order ${matchingOrder.id}`
          );
        }
      } else if (matchingOrders.length > 1) {
        console.warn(
          `[OCR] Multiple orders found for PO ${finalPoNumber}, ticket remains unlinked`
        );
      }
    }

    // Update ticket with extracted data
    await prisma.ticket.update({
      where: { id: ocrJob.ticket.id },
      data: {
        ocrRawText: extracted.rawText,
        ocrConfidence: extracted.ocrConfidence,
        material: extracted.material || ocrJob.ticket.material,
        quantity: extracted.quantity || ocrJob.ticket.quantity,
        poNumber: finalPoNumber,
        ticketNumber: extracted.ticketNumber || ocrJob.ticket.ticketNumber,
        ticketDate: extracted.ticketDate || ocrJob.ticket.ticketDate,
        linkedOrderId,
        status: ticketStatus,
        linkMethod,
      },
    });

    // Mark job as completed
    await prisma.ocrJob.update({
      where: { id: jobId },
      data: {
        status: OcrJobStatus.COMPLETED,
        finishedAt: new Date(),
        rawResponse: extracted as any,
      },
    });

    console.log(`[OCR] Successfully processed job ${jobId}`);
  } catch (error: any) {
    console.error(`[OCR] Error processing job ${jobId}:`, error?.message);

    // Mark job as failed
    try {
      await prisma.ocrJob.update({
        where: { id: jobId },
        data: {
          status: OcrJobStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: error?.message || 'Unknown error',
        },
      });
    } catch (updateError) {
      console.error(`[OCR] Failed to update job status for ${jobId}:`, updateError);
    }
  }
}

/**
 * Process all pending OCR jobs
 * This can be called periodically by a cron job or triggered manually
 */
export async function processPendingOcrJobs(): Promise<number> {
  try {
    const pendingJobs = await prisma.ocrJob.findMany({
      where: { status: OcrJobStatus.PENDING },
    });

    console.log(`[OCR] Found ${pendingJobs.length} pending OCR jobs`);

    // Process each job
    for (const job of pendingJobs) {
      await processOcrJob(job.id);
    }

    return pendingJobs.length;
  } catch (error) {
    console.error('[OCR] Error processing pending jobs:', error);
    return 0;
  }
}

/**
 * Trigger OCR processing for a specific ticket (async, non-blocking)
 * This is called automatically when a ticket is created
 */
export function triggerOcrProcessing(jobId: string): void {
  // Use setImmediate to process in next event loop iteration without blocking
  setImmediate(async () => {
    await processOcrJob(jobId).catch((error) => {
      console.error(`[OCR] Unhandled error in background OCR processing for job ${jobId}:`, error);
    });
  });
}
