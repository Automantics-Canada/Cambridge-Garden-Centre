/**
 * Counting and cutting the pages of an emailed PDF.
 *
 * A supplier's email can carry one PDF holding the invoice and, behind it, the
 * delivery tickets for the loads it bills (A15). The pages are sorted first
 * (services/emailTriage.ts); these two functions then build the invoice-only
 * PDF and one single-page PDF per ticket. pdf-lib copies pages as they are:
 * nothing is re-rendered, so text and images reach the reader unchanged.
 *
 * A PDF pdf-lib cannot open (damaged, or encrypted) is not split: pdf-lib
 * cannot decrypt, so pages copied out of an encrypted file would be
 * unreadable. An encrypted file's pages can still be counted (inspectPdf), so
 * the caller knows a file of several tickets is several, and sends it to a
 * person instead of filing it as one.
 */
import { PDFDocument } from 'pdf-lib';

/** Above this many pages a PDF is not split: it is not an invoice with a few tickets. */
export const MAX_SPLIT_PAGES = 60;

async function open(bytes: Buffer): Promise<PDFDocument | null> {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    // pdf-lib reads the page tree lazily, so a file with a broken catalog
    // loads and only fails here.
    document.getPageCount();
    return document;
  } catch {
    // Damaged, encrypted or not a PDF at all.
    return null;
  }
}

/** How many pages the PDF has, or null when it cannot be opened. */
export async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  const document = await open(bytes);
  return document ? document.getPageCount() : null;
}

/**
 * The page count, read even from an encrypted PDF (whose page tree pdf-lib
 * can read without decrypting), and whether it is encrypted. `pageCount` is
 * null for a file that cannot be read at all.
 */
export async function inspectPdf(bytes: Buffer): Promise<{ pageCount: number | null; encrypted: boolean }> {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    return { pageCount: document.getPageCount(), encrypted: document.isEncrypted };
  } catch {
    return { pageCount: null, encrypted: false };
  }
}

/**
 * A new PDF holding only these pages (numbered from 1), in the order given.
 * Throws when the PDF cannot be opened or a page does not exist: the caller
 * asked for pages it was told are there, so a miss is a real fault.
 */
export async function extractPdfPages(bytes: Buffer, pages: readonly number[]): Promise<Buffer> {
  const source = await open(bytes);
  if (!source) throw new Error('The PDF could not be opened to split it');
  const count = source.getPageCount();
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > count) {
      throw new Error(`Page ${page} is not in this ${count}-page PDF`);
    }
  }
  const target = await PDFDocument.create();
  const copied = await target.copyPages(source, pages.map((page) => page - 1));
  for (const page of copied) target.addPage(page);
  return Buffer.from(await target.save());
}
