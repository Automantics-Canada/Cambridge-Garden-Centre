import path from 'node:path';
import fs from 'node:fs';
import axios from 'axios';
import type { z } from 'zod';
import { isSupabaseUrl, getFilenameFromUrl } from '../urlHandler.js';
import { openaiExtractionProvider } from './providers/openai.adapter.js';
import {
  ExtractionError,
  type ExtractionDocument,
  type ExtractionProvider,
  type ExtractOptions,
} from './providers/types.js';
import { INVOICE_PROMPT, TICKET_PROMPT, TRIAGE_PROMPT } from './prompts.js';
import {
  DocumentTriageSchema,
  InvoiceExtractionSchema,
  TicketExtractionSchema,
  type DocumentTriage,
} from './schemas.js';
import { readSpreadsheet, spreadsheetToText, SpreadsheetError } from '../../lib/spreadsheet.js';
import {
  normalizeInvoice,
  normalizeTicket,
  type NormalizedInvoice,
  type NormalizedTicket,
} from './normalize.js';

/**
 * Reading a delivery ticket or a supplier invoice into fields.
 *
 * This is the whole extraction surface. It replaced a two-service AWS chain —
 * Textract flattened the document into a list of text lines, then Bedrock tried
 * to reconstruct meaning from those lines — with a single call to a vision
 * model that reads the document itself. The middle step was where most of the
 * accuracy went: a scale ticket's columns, and which company is printed at the
 * top, do not survive being turned into an unordered list of strings.
 */

export { ExtractionError } from './providers/types.js';
export type { NormalizedInvoice, NormalizedTicket } from './normalize.js';

/** Swapping this line is the whole cost of changing provider. */
let provider: ExtractionProvider = openaiExtractionProvider;

/**
 * Puts a stand-in provider in place and returns the function that restores the
 * real one. For tests: `npm test` never calls a model or the network.
 */
export function setExtractionProviderForTests(standIn: ExtractionProvider): () => void {
  const previous = provider;
  provider = standIn;
  return () => {
    provider = previous;
  };
}

export function activeProvider(): { name: string; modelId: string } {
  return { name: provider.name, modelId: provider.modelId };
}

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME_TYPE = 'text/csv';

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // Excel and CSV invoices (A12) are read as text; see readableDocument.
  // Legacy .xls is not here: nothing in this codebase can read it, so it is
  // refused permanently and the email waits for a person instead.
  '.xlsx': XLSX_MIME_TYPE,
  '.csv': CSV_MIME_TYPE,
};

const SPREADSHEET_MIME_TYPES = new Set([XLSX_MIME_TYPE, CSV_MIME_TYPE]);

export function isSpreadsheetMimeType(mimeType: string): boolean {
  return SPREADSHEET_MIME_TYPES.has(mimeType.toLowerCase());
}

/**
 * Most characters of spreadsheet text sent to the model. A supplier's invoice
 * workbook is a few hundred rows at most; this keeps a stray 5,000-row export
 * from becoming an expensive, slow and probably truncated reply.
 */
export const MAX_SPREADSHEET_TEXT_CHARS = 60_000;

/** Documents above this are refused before being sent anywhere. */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export function mimeTypeForFilename(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  const mimeType = MIME_TYPES_BY_EXTENSION[extension];
  if (!mimeType) {
    throw new ExtractionError(
      `Unsupported document type "${extension || 'no extension'}" for ${filename}`,
      { retryable: false }
    );
  }
  return mimeType;
}

/**
 * Loads a stored document into memory.
 *
 * Supabase Storage is the only remote origin allowed, matching the guard in
 * urlHandler: an extraction runs with our credentials, so following an
 * arbitrary URL out of a database column would make this a fetch-anything
 * service. Legacy `/uploads/` paths are still read for rows predating Supabase
 * storage, with the same containment check the OCR service used.
 */
async function loadDocument(fileUrl: string): Promise<ExtractionDocument> {
  if (isSupabaseUrl(fileUrl)) {
    const filename = getFilenameFromUrl(fileUrl);
    const response = await axios.get<ArrayBuffer>(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 15_000,
      maxRedirects: 0,
      maxContentLength: MAX_DOCUMENT_BYTES,
      maxBodyLength: MAX_DOCUMENT_BYTES,
    });
    return {
      bytes: Buffer.from(response.data),
      mimeType: mimeTypeForFilename(filename),
      filename,
    };
  }

  if (fileUrl.startsWith('/uploads/')) {
    const uploadsRoot = path.resolve(process.cwd(), 'uploads');
    const requestedPath = path.resolve(process.cwd(), `.${fileUrl}`);
    if (!requestedPath.startsWith(`${uploadsRoot}${path.sep}`)) {
      throw new ExtractionError('Invalid legacy upload path', { retryable: false });
    }
    if (!fs.existsSync(requestedPath)) {
      throw new ExtractionError(`Document not found: ${fileUrl}`, { retryable: false });
    }
    const filename = path.basename(requestedPath);
    return {
      bytes: await fs.promises.readFile(requestedPath),
      mimeType: mimeTypeForFilename(filename),
      filename,
    };
  }

  throw new ExtractionError('Unsupported document location', { retryable: false });
}

function assertReadableSize(document: ExtractionDocument): void {
  if (document.bytes.length === 0) {
    throw new ExtractionError(`Document ${document.filename} is empty`, { retryable: false });
  }
  if (document.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new ExtractionError(
      `Document ${document.filename} is ${Math.round(document.bytes.length / 1024 / 1024)}MB, above the ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB limit`,
      { retryable: false }
    );
  }
}

/**
 * The document as the model should see it. A PDF or image goes as it is. A
 * spreadsheet becomes bounded text first: every sheet, capped in sheets, rows,
 * columns and characters by lib/spreadsheet.ts (the same reader the price-list
 * import uses), with formulas giving their saved value and never evaluated.
 *
 * A spreadsheet that cannot be read fails for good: the same bytes will not
 * read better on a retry, so a person is told instead.
 */
export async function readableDocument(document: ExtractionDocument): Promise<ExtractionDocument> {
  if (typeof document.text === 'string' || !isSpreadsheetMimeType(document.mimeType)) return document;
  try {
    const sheet = await readSpreadsheet(document.bytes, { filename: document.filename, overflow: 'truncate' });
    const { text, truncated } = spreadsheetToText(sheet, MAX_SPREADSHEET_TEXT_CHARS);
    if (!text.trim()) {
      throw new ExtractionError(`Spreadsheet ${document.filename} has no rows to read`, { retryable: false });
    }
    if (truncated) {
      console.warn(`[Extraction] Spreadsheet ${document.filename} was longer than the reader takes; only the first part was read`);
    }
    return { ...document, text };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    const message = error instanceof SpreadsheetError ? error.message : String((error as Error)?.message ?? error);
    throw new ExtractionError(`Spreadsheet ${document.filename} could not be read: ${message}`, {
      retryable: false,
      cause: error,
    });
  }
}

async function read<Raw, Result>(
  document: ExtractionDocument,
  kind: 'ticket' | 'invoice',
  prompt: string,
  schema: z.ZodType<Raw>,
  schemaName: string,
  normalize: (raw: Raw) => Result
): Promise<Result> {
  assertReadableSize(document);
  const readable = await readableDocument(document);
  console.log(
    `[Extraction] Reading ${kind} ${document.filename} (${readable.text !== undefined ? 'as text' : document.mimeType}) with ${provider.name}/${provider.modelId}`
  );
  const raw = await provider.extract(readable, prompt, schema, schemaName);
  return normalize(raw);
}

/**
 * What each page of an emailed attachment is: invoice, delivery ticket,
 * statement, credit memo or other. One small call per attachment, made before
 * anything is created from it (services/emailTriage.ts decides what to do with
 * the answer). The reply is a short list, so its output budget is small.
 */
export async function triageDocument(
  bytes: Buffer,
  mimeType: string,
  filename = 'attachment'
): Promise<DocumentTriage> {
  const document: ExtractionDocument = { bytes, mimeType, filename };
  assertReadableSize(document);
  const readable = await readableDocument(document);
  console.log(`[Extraction] Sorting the pages of ${filename} with ${provider.name}/${provider.modelId}`);
  return provider.extract(readable, TRIAGE_PROMPT, DocumentTriageSchema, 'attachment_triage', {
    maxOutputTokens: 4_000,
  });
}

/**
 * Reads any document into `schema`, for callers with their own prompt and
 * checks (the Spruce report reader). The provider stays private to this file.
 */
export async function extractStructured<T>(
  document: ExtractionDocument,
  prompt: string,
  schema: z.ZodType<T>,
  schemaName: string,
  options?: ExtractOptions
): Promise<T> {
  assertReadableSize(document);
  console.log(
    `[Extraction] Reading ${schemaName} ${document.filename} with ${provider.name}/${options?.modelId ?? provider.modelId}`
  );
  return provider.extract(await readableDocument(document), prompt, schema, schemaName, options);
}

/** Reads a delivery ticket already held in memory. */
export async function extractTicket(
  bytes: Buffer,
  mimeType: string,
  filename = 'ticket'
): Promise<NormalizedTicket> {
  return read(
    { bytes, mimeType, filename },
    'ticket',
    TICKET_PROMPT,
    TicketExtractionSchema,
    'delivery_ticket',
    normalizeTicket
  );
}

/** Reads a supplier invoice already held in memory. */
export async function extractInvoice(
  bytes: Buffer,
  mimeType: string,
  filename = 'invoice'
): Promise<NormalizedInvoice> {
  return read(
    { bytes, mimeType, filename },
    'invoice',
    INVOICE_PROMPT,
    InvoiceExtractionSchema,
    'supplier_invoice',
    normalizeInvoice
  );
}

/** Reads a delivery ticket from its stored location. */
export async function extractTicketFromUrl(fileUrl: string): Promise<NormalizedTicket> {
  const document = await loadDocument(fileUrl);
  return extractTicket(document.bytes, document.mimeType, document.filename);
}

/** Reads a supplier invoice from its stored location. */
export async function extractInvoiceFromUrl(fileUrl: string): Promise<NormalizedInvoice> {
  const document = await loadDocument(fileUrl);
  return extractInvoice(document.bytes, document.mimeType, document.filename);
}
