import { extractPdfTextPages, SprucePdfError, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
import { detectSpruceReport } from './detectSpruceReport.js';
import { parseDeliveryReport } from './parseDeliveryReport.js';
import { parseItemTrackingReport } from './parseItemTrackingReport.js';
import { parseOrderSummaryReport } from './parseOrderSummaryReport.js';
import type { ParsedSpruceReport, SpruceReportType } from './spruceReportTypes.js';

/**
 * Reads a Spruce order report of any of the three layouts.
 *
 * The single way in for both the order import and the PO merge, so that
 * whichever report the yard uploads is recognised and read the same way by
 * both.
 */

const PARSERS: Record<SpruceReportType, (pages: PdfTextPage[]) => ParsedSpruceReport> = {
  ORDER_SUMMARY: parseOrderSummaryReport,
  ITEM_TRACKING: parseItemTrackingReport,
  DELIVERY: parseDeliveryReport,
};

/** A printed range: `08/14/26 - 08/14/26`, or `8/14/2026 To 8/14/2026`. */
const DATE_RANGE = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:-|to)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i;

/**
 * The range a report was filtered on, from the parameter line near the top of
 * its first page. Every layout prints one, worded differently; the first
 * date pair on the page is it, since nothing above it carries two dates.
 */
export function readReportDateRange(pages: PdfTextPage[]): ParsedSpruceReport['dateRange'] {
  const first = pages[0];
  if (!first) return undefined;

  const ordered = [...first.runs].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const run of ordered) {
    const match = DATE_RANGE.exec(run.text);
    if (match) return { fromRaw: match[1]!, toRaw: match[2]! };
  }
  return undefined;
}

/** Reads already-extracted pages. Separated so parsing can be tested alone. */
export function parseSprucePages(pages: PdfTextPage[]): ParsedSpruceReport {
  const report = PARSERS[detectSpruceReport(pages)](pages);
  const dateRange = readReportDateRange(pages);

  return {
    ...report,
    pageCount: pages.length,
    ...(dateRange ? { dateRange } : {}),
  };
}

/**
 * The layout reader's failures an AI model may succeed where it did not: a
 * changed layout, or a retitled report. A file with no text layer is not one —
 * the model's answer could not be checked against anything.
 */
const AI_CAN_READ = new Set<SprucePdfError['code']>([
  'UNKNOWN_REPORT',
  'MISSING_HEADERS',
  'NO_READABLE_ROWS',
  'ROW_COUNT_MISMATCH',
]);

/** The report type the layout reader recognises, or null for the model to decide. */
function recognisedType(pages: PdfTextPage[]): SpruceReportType | null {
  try {
    return detectSpruceReport(pages);
  } catch {
    return null;
  }
}

/**
 * Reads a Spruce report PDF.
 *
 * By default (SPRUCE_READER=auto) the layout reader reads it, and an AI model
 * reads it instead when the layout reader cannot, or could not read some of
 * its lines. If the model fails too, the layout reader's own error stands:
 * falling back never makes an upload worse. SPRUCE_READER=ai sends every
 * report to the model; SPRUCE_READER=parser never does.
 *
 * Throws `SprucePdfError` when the file has no text layer, is not one of the
 * three reports, or is missing the columns its layout needs.
 */
export async function parseSprucePdf(buffer: Buffer): Promise<ParsedSpruceReport> {
  const pages = await extractPdfTextPages(buffer);
  // Loaded here, not at the top: parseSprucePages is used by tests and scripts
  // that have no environment configured, and env.ts refuses to load without one.
  const { env } = await import('../../../config/env.js');
  const { aiReadSpruceReport } = await import('./aiReadSpruceReport.js');

  const withDates = (report: ParsedSpruceReport): ParsedSpruceReport => {
    const dateRange = readReportDateRange(pages);
    return { ...report, pageCount: pages.length, ...(dateRange ? { dateRange } : {}) };
  };

  if (env.spruceReader === 'parser') return parseSprucePages(pages);
  if (env.spruceReader === 'ai') return withDates(await aiReadSpruceReport(buffer, pages, recognisedType(pages)));

  let parsed: ParsedSpruceReport;
  try {
    parsed = parseSprucePages(pages);
  } catch (err) {
    if (!(err instanceof SprucePdfError) || !AI_CAN_READ.has(err.code)) throw err;
    try {
      const read = withDates(await aiReadSpruceReport(buffer, pages, recognisedType(pages)));
      console.warn(`[SpruceImport] Layout reader failed (${err.code}); the AI read ${read.rows.length} line(s)`);
      return read;
    } catch (aiErr) {
      console.error('[SpruceImport] The AI could not read the report either', aiErr);
      throw err;
    }
  }

  if (parsed.unreadable.length === 0) return { ...parsed, readBy: 'PARSER' };
  try {
    const read = withDates(await aiReadSpruceReport(buffer, pages, parsed.type));
    // Only a better reading replaces the layout reader's.
    if (read.unreadable.length < parsed.unreadable.length) return read;
  } catch (aiErr) {
    console.error('[SpruceImport] The AI could not read the report', aiErr);
  }
  return { ...parsed, readBy: 'PARSER' };
}

/** How the report names itself, for messages shown to a person. */
export const REPORT_LABELS: Record<SpruceReportType, string> = {
  ORDER_SUMMARY: 'Customer Order Summary',
  ITEM_TRACKING: 'Sales Order Item Tracking',
  DELIVERY: 'delivery run sheet',
};
