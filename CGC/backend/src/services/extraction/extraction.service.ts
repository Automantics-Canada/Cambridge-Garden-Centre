import path from 'node:path';
import fs from 'node:fs';
import axios from 'axios';
import type { z } from 'zod';
import { isSupabaseUrl, getFilenameFromUrl } from '../urlHandler.js';
import { openaiExtractionProvider } from './providers/openai.adapter.js';
import { ExtractionError, type ExtractionDocument, type ExtractionProvider } from './providers/types.js';
import { INVOICE_PROMPT, TICKET_PROMPT } from './prompts.js';
import { InvoiceExtractionSchema, TicketExtractionSchema } from './schemas.js';
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
const provider: ExtractionProvider = openaiExtractionProvider;

export function activeProvider(): { name: string; modelId: string } {
  return { name: provider.name, modelId: provider.modelId };
}

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

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

async function read<Raw, Result>(
  document: ExtractionDocument,
  kind: 'ticket' | 'invoice',
  prompt: string,
  schema: z.ZodType<Raw>,
  schemaName: string,
  normalize: (raw: Raw) => Result
): Promise<Result> {
  assertReadableSize(document);
  console.log(
    `[Extraction] Reading ${kind} ${document.filename} (${document.mimeType}) with ${provider.name}/${provider.modelId}`
  );
  const raw = await provider.extract(document, prompt, schema, schemaName);
  return normalize(raw);
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
