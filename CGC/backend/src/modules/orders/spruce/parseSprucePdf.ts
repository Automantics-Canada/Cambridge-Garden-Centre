import { extractPdfTextPages, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
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
 * Reads a Spruce report PDF.
 *
 * Throws `SprucePdfError` when the file has no text layer, is not one of the
 * three reports, or is missing the columns its layout needs.
 */
export async function parseSprucePdf(buffer: Buffer): Promise<ParsedSpruceReport> {
  return parseSprucePages(await extractPdfTextPages(buffer));
}

/** How the report names itself, for messages shown to a person. */
export const REPORT_LABELS: Record<SpruceReportType, string> = {
  ORDER_SUMMARY: 'Customer Order Summary',
  ITEM_TRACKING: 'Sales Order Item Tracking',
  DELIVERY: 'delivery run sheet',
};
