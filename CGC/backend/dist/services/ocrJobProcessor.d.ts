/**
 * Process a single OCR job asynchronously
 * This function handles the entire OCR pipeline:
 * 1. Extract text from image using AWS Textract
 * 2. Parse extracted data
 * 3. Auto-link to orders if PO number matches
 * 4. Update ticket and job status
 */
export declare function processOcrJob(jobId: string): Promise<void>;
/**
 * Process all pending OCR jobs
 * This can be called periodically by a cron job or triggered manually
 */
export declare function processPendingOcrJobs(): Promise<number>;
/**
 * Trigger OCR processing for a specific ticket (async, non-blocking)
 * This is called automatically when a ticket is created
 */
export declare function triggerOcrProcessing(jobId: string): void;
//# sourceMappingURL=ocrJobProcessor.d.ts.map