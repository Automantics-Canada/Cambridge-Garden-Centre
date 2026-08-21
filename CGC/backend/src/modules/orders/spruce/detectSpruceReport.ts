import { SprucePdfError, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
import type { SpruceReportType } from './spruceReportTypes.js';

/**
 * Works out which Spruce report was uploaded.
 *
 * The yard runs several reports off the same day and uploads whichever one it
 * needs, so the importer reads the report rather than being told what it is.
 * Each layout names itself at the top of the first page; the delivery run sheet
 * has no title, but its column strip is unmistakable.
 */

interface Signature {
  type: SpruceReportType;
  /** Matched against the first page's leading text, lower-cased. */
  marker: string;
}

const SIGNATURES: Signature[] = [
  { type: 'ORDER_SUMMARY', marker: 'customer order summary' },
  { type: 'ITEM_TRACKING', marker: 'sales order item tracking' },
  // The run sheet prints no title. This strip sits above its first order and
  // appears on no other report.
  { type: 'DELIVERY', marker: '(inv / tkt / ord)' },
];

/**
 * How far down the first page to look for a title.
 *
 * A generous fraction rather than the first line or two: the reports differ in
 * how much letterhead precedes the title, and one of them prints it below a
 * parameters block.
 */
const TITLE_SEARCH_FRACTION = 0.35;

function leadingText(page: PdfTextPage): string {
  const cutoff = page.height > 0 ? page.height * TITLE_SEARCH_FRACTION : Number.POSITIVE_INFINITY;

  return page.runs
    .filter(run => run.y <= cutoff)
    .map(run => run.text)
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * Names the report, or explains what it saw instead.
 *
 * Refusing an unrecognised layout is deliberate. Every parser here reads by
 * position, so running one against a report it was not written for would not
 * fail loudly — it would return confident, wrong rows.
 */
export function detectSpruceReport(pages: PdfTextPage[]): SpruceReportType {
  const first = pages[0];
  if (!first) {
    throw new SprucePdfError('UNKNOWN_REPORT', 'This PDF has no pages in it.');
  }

  const heading = leadingText(first);
  const comparable = heading.toLowerCase();

  for (const signature of SIGNATURES) {
    if (comparable.includes(signature.marker)) return signature.type;
  }

  throw new SprucePdfError(
    'UNKNOWN_REPORT',
    `This does not look like a Spruce order report. Expected the Customer Order Summary, ` +
      `the Sales Order Item Tracking report, or the delivery run sheet, but the top of the ` +
      `page reads "${summarise(heading)}".`
  );
}

/** A short, quoted glimpse of the page, to make the message actionable. */
function summarise(heading: string): string {
  const trimmed = heading.trim();
  if (trimmed.length === 0) return '(nothing)';
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
}
