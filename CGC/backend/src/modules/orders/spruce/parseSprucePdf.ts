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

/** Reads already-extracted pages. Separated so parsing can be tested alone. */
export function parseSprucePages(pages: PdfTextPage[]): ParsedSpruceReport {
  return PARSERS[detectSpruceReport(pages)](pages);
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
