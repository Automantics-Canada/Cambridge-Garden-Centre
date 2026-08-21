import PDFParser, { type Output, type Page as RawPage } from 'pdf2json';

/**
 * Positioned text extraction for Spruce report PDFs.
 *
 * Spruce exports digital PDFs with an exact text layer: every item code,
 * description and figure already carries its own coordinates. The importer used
 * to send these pages to Textract, which rasterises them and *infers* a table
 * from pixels — discarding known-good positions and then guessing at them. That
 * guessing is what bound descriptions to the wrong item codes.
 *
 * This module is the one place that touches pdf2json. Everything downstream
 * sees `PdfTextPage` only, so the underlying library can be replaced without
 * reaching into the parsers.
 *
 * OCR is deliberately not a fallback here. A Spruce export always has a text
 * layer; a file without one is a scan or a photo of a printout, and silently
 * OCR-guessing it would reintroduce exactly the failure this replaced. Such a
 * file is rejected with an explanation instead.
 */

/** Why a Spruce PDF could not be read. Carries a message fit to show a user. */
export type SprucePdfErrorCode =
  | 'NO_TEXT_LAYER'
  | 'UNKNOWN_REPORT'
  | 'MISSING_HEADERS';

export class SprucePdfError extends Error {
  readonly code: SprucePdfErrorCode;

  constructor(code: SprucePdfErrorCode, message: string) {
    super(message);
    this.name = 'SprucePdfError';
    this.code = code;
  }
}

/**
 * One run of text as the PDF draws it.
 *
 * pdf2json groups a cell's text into a single run rather than splitting it into
 * words, which is what makes these reports tractable: a long description that
 * visually overflows into the Qty column still arrives as one run anchored at
 * the description's own x, so assigning it to a column is a single lookup and
 * never interleaves with the number drawn on top of it.
 *
 * `x`, `y` and `w` are in pdf2json's own unit space (1/16th of a PDF point on
 * these reports), and `y` uses a different origin than other PDF tools report.
 * Nothing may hardcode a value in this space — column boundaries are always
 * derived from the header row of the page being read.
 */
export interface PdfTextRun {
  text: string;
  x: number;
  y: number;
  /** Drawn width, in the same unit space as `x`. */
  w: number;
  /**
   * Size as pdf2json reports it. Diagnostics only.
   *
   * Spruce shrinks text to fit its cell, so this varies continuously with how
   * long a description is (roughly 13.7 down to 5.7 on the sample reports)
   * rather than separating field values from anything. Branching on it
   * misclassifies legitimate wrapped text; use position instead.
   */
  fontSize: number;
}

export interface PdfTextPage {
  /** Zero-based. */
  pageIndex: number;
  width: number;
  height: number;
  runs: PdfTextRun[];
}

/**
 * Percent-decodes one pdf2json text run.
 *
 * pdf2json percent-encodes run text, but emits sequences `decodeURIComponent`
 * rejects — at least one per page on the sample reports, and a thrown
 * `URIError` there would abort an entire import over a single cell. The
 * fallback decodes the well-formed escapes and leaves the rest as written,
 * which keeps the run readable and positioned rather than losing the row.
 *
 * Exported for tests: the malformed input that motivates the fallback is
 * awkward to reach through a whole PDF.
 */
export function decodeRunText(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }
}

/**
 * A page carrying nothing but a letterhead would still clear a per-page check,
 * so the threshold is applied across the document. A one-page Spruce report
 * with a single order still runs to several hundred characters.
 */
const MIN_TEXT_CHARS = 20;

const NO_TEXT_LAYER_MESSAGE =
  'This PDF has no readable text in it, so it looks like a scan or a photo of a printout. ' +
  'Export the report again from Spruce and upload that file.';

/**
 * Rejects a document with no usable text layer.
 *
 * A scan still parses as a valid PDF — it simply carries images where the text
 * should be — so emptiness is what distinguishes it, not a parse failure.
 *
 * Exported for tests.
 */
export function assertHasTextLayer(pages: PdfTextPage[]): void {
  let total = 0;
  for (const page of pages) {
    for (const run of page.runs) total += run.text.trim().length;
  }

  if (total < MIN_TEXT_CHARS) {
    throw new SprucePdfError('NO_TEXT_LAYER', NO_TEXT_LAYER_MESSAGE);
  }
}

/**
 * Reads every text run of a PDF with its position.
 *
 * Resolves with one entry per page in page order. Throws `SprucePdfError` when
 * the file carries no usable text layer, and rethrows pdf2json's own parse
 * failures (a corrupt or encrypted file) unchanged.
 */
export async function extractPdfTextPages(buffer: Buffer): Promise<PdfTextPage[]> {
  const pages = await new Promise<PdfTextPage[]>((resolve, reject) => {
    // No context object, and no raw-text pass: only positioned runs are read.
    const parser = new PDFParser(null, false);

    parser.on('pdfParser_dataError', errData => {
      // pdf2json reports either a bare Error or a wrapper around one.
      const cause = errData instanceof Error ? errData : errData.parserError;
      reject(cause instanceof Error ? cause : new Error(String(cause ?? 'PDF parse failed')));
    });

    parser.on('pdfParser_dataReady', (pdfData: Output) => {
      try {
        resolve(normalisePages(pdfData));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Verbosity 0: pdf2json otherwise logs a line per page onto the same stdout
    // the import stream writes to.
    parser.parseBuffer(buffer, 0);
  });

  assertHasTextLayer(pages);

  return pages;
}

/**
 * Maps pdf2json's output onto `PdfTextPage`s.
 *
 * Separated from the parse so it can be exercised directly: pdf2json only
 * accepts PDFs produced by a real writer, so a fixture PDF small enough to
 * commit is not a practical way to reach this code.
 */
export function normalisePages(pdfData: Output): PdfTextPage[] {
  const rawPages: RawPage[] = pdfData.Pages ?? [];

  return rawPages.map((rawPage, pageIndex) => {
    const runs: PdfTextRun[] = [];

    for (const text of rawPage.Texts ?? []) {
      const parts = text.R ?? [];
      // A cell's styled fragments share one position; joining them keeps the
      // cell whole rather than emitting a run per style change.
      const joined = parts.map(part => decodeRunText(part.T)).join('');
      if (joined.trim().length === 0) continue;

      runs.push({
        text: joined,
        x: text.x,
        y: text.y,
        w: text.w ?? 0,
        fontSize: parts[0]?.TS?.[1] ?? 0,
      });
    }

    // Reading order: top to bottom, then left to right. Callers cluster by `y`
    // rather than relying on this, but a stable order keeps parses reproducible
    // and makes row numbers in error messages mean something.
    runs.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

    return {
      pageIndex,
      width: rawPage.Width ?? 0,
      height: rawPage.Height ?? 0,
      runs,
    };
  });
}
