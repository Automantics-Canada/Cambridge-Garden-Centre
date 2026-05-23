import { prisma } from '../db/prisma.js';
import { extractTextFromLocalImage } from './ocr.service.js';
import { OcrJobStatus, TicketStatus, OcrJobType, } from '@prisma/client';
import { InvoiceService } from '../modules/invoices/invoice.service.js';
/**
 * Process a single OCR job asynchronously
 * This function handles the entire OCR pipeline:
 * 1. Extract text from image using AWS Textract
 * 2. Parse extracted data
 * 3. Auto-link to orders if PO number matches
 * 4. Update ticket and job status
 */
export async function processOcrJob(jobId) {
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
        // Update job status to PROCESSING
        await prisma.ocrJob.update({
            where: { id: jobId },
            data: {
                status: OcrJobStatus.PROCESSING,
                startedAt: new Date(),
            },
        });
        const targetId = ocrJob.ticket?.id || ocrJob.invoice?.id;
        console.log(`[OCR] Processing job ${jobId} for entity ${targetId}`);
        if (ocrJob.type === OcrJobType.TICKET && ocrJob.ticket) {
            console.log(`[OCR] Processing Ticket OCR for: ${ocrJob.ticket.id}`);
            // Delegate to TicketService to ensure consistent logic (junction table, etc.)
            const { TicketService } = await import('../modules/tickets/ticket.service.js');
            await TicketService.processTicketOcr(ocrJob.ticket.id);
        }
        else if (ocrJob.type === OcrJobType.INVOICE && ocrJob.invoice) {
            console.log(`[OCR] Processing Invoice OCR for: ${ocrJob.invoice.id}`);
            // Delegate to InvoiceService
            await InvoiceService.processInvoiceOcr(ocrJob.invoice.id);
            // InvoiceService already updates the ocrJob status inside its method
        }
        console.log(`[OCR] Successfully processed job ${jobId}`);
    }
    catch (error) {
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
        }
        catch (updateError) {
            console.error(`[OCR] Failed to update job status for ${jobId}:`, updateError);
        }
    }
}
let isProcessingPending = false;
/**
 * Process all pending OCR jobs
 * This can be called periodically by a cron job or triggered manually
 */
export async function processPendingOcrJobs() {
    if (isProcessingPending) {
        console.log('[OCR] Pending jobs processing already in progress. Skipping...');
        return 0;
    }
    try {
        isProcessingPending = true;
        const pendingJobs = await prisma.ocrJob.findMany({
            where: {
                status: OcrJobStatus.PENDING,
                type: OcrJobType.TICKET,
            },
        });
        console.log(`[OCR] Found ${pendingJobs.length} pending OCR jobs`);
        // Process each job
        for (const job of pendingJobs) {
            await processOcrJob(job.id);
        }
        return pendingJobs.length;
    }
    catch (error) {
        console.error('[OCR] Error processing pending jobs:', error);
        return 0;
    }
    finally {
        isProcessingPending = false;
    }
}
/**
 * Trigger OCR processing for a specific ticket (async, non-blocking)
 * This is called automatically when a ticket is created
 */
export function triggerOcrProcessing(jobId) {
    // Use setImmediate to process in next event loop iteration without blocking
    setImmediate(async () => {
        await processOcrJob(jobId).catch((error) => {
            console.error(`[OCR] Unhandled error in background OCR processing for job ${jobId}:`, error);
        });
    });
}
//# sourceMappingURL=ocrJobProcessor.js.map