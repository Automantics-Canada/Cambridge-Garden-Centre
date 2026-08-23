/**
 * Reading a supplier invoice.
 *
 * AWS Textract AnalyzeExpense does the OCR. The deterministic extractor turns its
 * structured output into typed, validated fields. Only what is left unresolved
 * after that is offered to the fallback reader.
 *
 * What this no longer does is flatten Textract's response to a wall of text and
 * ask a language model to find the numbers in it. That threw away the per-field
 * confidence Textract had already produced, and made a hallucinated unit price
 * indistinguishable from a scanned one by the time it reached the ledger.
 */

import {
  TextractClient,
  AnalyzeExpenseCommand,
} from '@aws-sdk/client-textract';
import path from 'node:path';
import fs from 'node:fs';
import {
  downloadFileToTemp,
  cleanupTempFile,
  isSupabaseUrl,
  getFilenameFromUrl,
} from './urlHandler.js';
import {
  extractInvoiceFromExpense,
  getOcrConfidenceFromExpense,
  getOcrTextFromExpense,
} from './documentExtraction/invoiceExtractor.js';
import { finaliseInvoiceExtraction } from './documentExtraction/mergeExtraction.js';
import type { ExtractionOutcome, InvoiceExtraction } from './documentExtraction/types.js';

const textractClient = new TextractClient();

export type InvoiceOcrOutcome = ExtractionOutcome<InvoiceExtraction>;

export interface InvoiceOcrInput {
  fileUrl: string;
  /** Used for operational logging and to tie fallback calls to a document. */
  jobId: string;
}

/**
 * Read an invoice from wherever it is stored.
 *
 * The caller gets the OCR text and the typed fields separately. The Textract
 * response itself does not leave this module — it is large, it contains page
 * geometry nobody downstream reads, and it used to be serialised into the
 * invoice's `ocrRawText` column in place of the actual text.
 */
export async function extractInvoiceDocument({
  fileUrl,
  jobId,
}: InvoiceOcrInput): Promise<InvoiceOcrOutcome> {
  let localPath = fileUrl;
  let tempFile: string | null = null;

  try {
    if (isSupabaseUrl(fileUrl)) {
      const filename = getFilenameFromUrl(fileUrl);
      tempFile = await downloadFileToTemp(fileUrl, filename);
      localPath = tempFile;
    } else if (fileUrl.startsWith('/uploads/')) {
      // Legacy local uploads, constrained to the uploads root so a crafted
      // fileUrl cannot walk out of it.
      const uploadsRoot = path.resolve(process.cwd(), 'uploads');
      const requested = path.resolve(process.cwd(), `.${fileUrl}`);
      if (!requested.startsWith(`${uploadsRoot}${path.sep}`)) {
        throw new Error('Invalid legacy upload path');
      }
      localPath = requested;
    } else {
      throw new Error('Unsupported invoice file location');
    }

    if (!fs.existsSync(localPath)) {
      throw new Error('Invoice file not found for OCR');
    }

    return await readInvoice(localPath, jobId);
  } finally {
    if (tempFile) await cleanupTempFile(tempFile);
  }
}

async function readInvoice(localPath: string, jobId: string): Promise<InvoiceOcrOutcome> {
  const response = await textractClient.send(
    new AnalyzeExpenseCommand({ Document: { Bytes: fs.readFileSync(localPath) } })
  );

  const ocrText = getOcrTextFromExpense(response);
  const ocrConfidence = getOcrConfidenceFromExpense(response);

  // No text at all is a failed read, not an empty invoice. Letting it through
  // would post an invoice with every field unresolved and no way to tell that
  // from a document that genuinely had nothing on it.
  if (!ocrText.trim()) {
    throw new Error('Textract detected no text in the invoice document');
  }

  const extraction = extractInvoiceFromExpense({ response, ocrText });

  return finaliseInvoiceExtraction({
    extraction,
    ocrText,
    ocrConfidence,
    documentType: 'INVOICE',
    jobId,
  });
}
