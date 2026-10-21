import { extractPdfTextPages, SprucePdfError, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
import { crossCheckReadings } from './crossCheckReadings.js';
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

/** How the reports are read; see SPRUCE_READER in config/env.ts. */
export type SpruceReaderMode = 'both' | 'auto' | 'ai' | 'parser';

export interface ReadOptions {
  /**
   * The AI's double-check, in the mode that runs one ('both'). 'await' waits
   * for it and compares the two readings: the import. 'start' only starts it,
   * so that its reading is ready by the time the import asks: the preview.
   * Left out, no double-check runs (a single report's import, the PO merge).
   */
  aiCheck?: 'await' | 'start';
  /** For tests: the mode, the AI reader and the wait, instead of the real ones. */
  mode?: SpruceReaderMode;
  readWithAi?: (buffer: Buffer, pages: PdfTextPage[], type: SpruceReportType | null) => Promise<ParsedSpruceReport>;
  aiCheckTimeoutMs?: number;
}

/**
 * How long the import waits for the AI's double-check before going on
 * without it. The model takes one to two and a half minutes on a busy day's
 * report; the import says when the check did not finish.
 */
const AI_CHECK_TIMEOUT_MS = 4 * 60 * 1000;

/** `4 minutes`, `30 seconds`: a wait as the dispatcher is told it. */
const spoken = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;

class AiCheckTimedOut extends Error {}

/**
 * Why the AI did not answer, in words that say who can fix it. On 21/10/2026
 * the account ran out of credit mid-morning; "could not be reached" would have
 * sent someone looking at the network.
 */
export function aiFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/credit|quota|billing/i.test(message)) return 'the AI account is out of credit';
  if (/\b(401|403)\b|api key|unauthori[sz]ed/i.test(message)) return 'the AI key was refused';
  return 'the AI could not be reached';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiCheckTimedOut(`no answer within ${spoken(ms)}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reads a Spruce report PDF.
 *
 * Throws `SprucePdfError` when the file has no text layer, is not one of the
 * three reports, or is missing the columns its layout needs.
 */
export async function parseSprucePdf(buffer: Buffer, options: ReadOptions = {}): Promise<ParsedSpruceReport> {
  return readSprucePages(buffer, await extractPdfTextPages(buffer), options);
}

/**
 * Reads a report as SPRUCE_READER says:
 *
 *  ai      (the default) the AI reads every report. Where it cannot answer —
 *          out of credit, down, too slow — the layout reader reads it instead
 *          and the import says so, rather than the morning's upload failing.
 *  both    the layout reader, and the AI reading the same report
 *          independently. Where they agree the reading is right twice over;
 *          where they differ the import names the orders and what differs.
 *          The layout reader's reading is the one imported. The AI reads
 *          alone where the layout reader cannot read the report at all, and
 *          the layout reader alone where the AI does not answer in time.
 *  auto    the layout reader; the AI only where it fails or leaves lines unread
 *  parser  the layout reader alone
 *
 * Whichever reader fails, the other's reading or the layout reader's own
 * error stands: asking the AI never makes an upload worse.
 */
export async function readSprucePages(
  buffer: Buffer,
  pages: PdfTextPage[],
  options: ReadOptions = {}
): Promise<ParsedSpruceReport> {
  // Loaded here, not at the top: parseSprucePages is used by tests and scripts
  // that have no environment configured, and env.ts refuses to load without one.
  const mode = options.mode ?? (await import('../../../config/env.js')).env.spruceReader;
  if (mode === 'parser') return { ...parseSprucePages(pages), readBy: 'PARSER' };

  const readWithAi = options.readWithAi ?? (await import('./aiReadSpruceReport.js')).aiReadSpruceReport;
  const timeoutMs = options.aiCheckTimeoutMs ?? AI_CHECK_TIMEOUT_MS;
  const ai = async (type: SpruceReportType | null, because?: string): Promise<ParsedSpruceReport> => {
    const read = await withTimeout(readWithAi(buffer, pages, type), timeoutMs);
    const dateRange = readReportDateRange(pages);
    return {
      ...read,
      pageCount: pages.length,
      ...(dateRange ? { dateRange } : {}),
      readBy: 'AI',
      ...(because ? { readByAiBecause: because } : {}),
    };
  };

  if (mode === 'ai') {
    try {
      return await ai(recognisedType(pages));
    } catch (aiErr) {
      // Not one of the three reports: the AI said so, and the layout reader would agree.
      if (aiErr instanceof SprucePdfError) throw aiErr;
      const reason = aiErr instanceof AiCheckTimedOut ? `it gave no answer within ${spoken(timeoutMs)}` : aiFailureReason(aiErr);
      console.error(`[SpruceImport] The AI could not read the report (${reason}); the layout reader reads it instead`, aiErr);
      // Throws its own SprucePdfError where it cannot read the report either.
      return { ...parseSprucePages(pages), readBy: 'PARSER', aiFailed: reason };
    }
  }

  let parsed: ParsedSpruceReport;
  try {
    parsed = parseSprucePages(pages);
  } catch (err) {
    if (!(err instanceof SprucePdfError) || !AI_CAN_READ.has(err.code)) throw err;
    try {
      const read = await ai(recognisedType(pages), 'its layout was not recognised');
      console.warn(`[SpruceImport] Layout reader failed (${err.code}); the AI read ${read.rows.length} line(s)`);
      return read;
    } catch (aiErr) {
      console.error('[SpruceImport] The AI could not read the report either', aiErr);
      throw err;
    }
  }

  const unreadByLayout = `the report reader could not read ${parsed.unreadable.length} of its lines`;

  if (mode !== 'both' || !options.aiCheck) {
    if (parsed.unreadable.length === 0) return { ...parsed, readBy: 'PARSER' };
    try {
      const read = await ai(parsed.type, unreadByLayout);
      // Only a better reading replaces the layout reader's.
      if (read.unreadable.length < parsed.unreadable.length) return read;
    } catch (aiErr) {
      console.error('[SpruceImport] The AI could not read the report', aiErr);
    }
    return { ...parsed, readBy: 'PARSER' };
  }

  const reading = ai(parsed.type, unreadByLayout);
  // Awaited below, or by the import that follows the preview; never left unhandled.
  reading.catch(() => undefined);
  if (options.aiCheck === 'start') return { ...parsed, readBy: 'PARSER' };

  let read: ParsedSpruceReport;
  try {
    read = await withTimeout(reading, options.aiCheckTimeoutMs ?? AI_CHECK_TIMEOUT_MS);
  } catch (aiErr) {
    console.error('[SpruceImport] The AI double-check did not finish', aiErr);
    const reason = aiErr instanceof AiCheckTimedOut
      ? `the AI gave no answer within ${spoken(options.aiCheckTimeoutMs ?? AI_CHECK_TIMEOUT_MS)}`
      : aiFailureReason(aiErr);
    return {
      ...parsed,
      readBy: 'PARSER',
      aiCheck: { status: 'unavailable', compared: 0, agreed: 0, differences: [], reason },
    };
  }

  const unsure = new Set(read.unreadable.flatMap(row => (row.documentNumber ? [row.documentNumber] : [])));
  const check = crossCheckReadings(parsed.rows, read.rows, unsure);
  const aiCheck = { status: check.differences.length ? 'differences' as const : 'agreed' as const, ...check };

  const orders = new Set([...parsed.rows, ...read.rows].map(row => row.documentNumber)).size;
  const differing = new Set(check.differences.map(difference => difference.documentNumber)).size;
  if (layoutChanged(differing, orders) && read.unreadable.length <= parsed.unreadable.length) {
    console.warn(`[SpruceImport] Readings differ on ${differing} of ${orders} orders; importing the AI's reading`);
    return {
      ...read,
      readByAiBecause: `it and the report reader differ on ${differing} of its ${orders} orders, ` +
        "which means Spruce has changed the report's layout",
      aiCheck,
    };
  }

  // Where the layout reader left lines unread and the AI read more, the AI's
  // reading is imported, as in 'auto'; the comparison is reported either way.
  const imported = parsed.unreadable.length > 0 && read.unreadable.length < parsed.unreadable.length
    ? read
    : { ...parsed, readBy: 'PARSER' as const };
  return { ...imported, aiCheck };
}

/**
 * Whether the two readings differ on so many of a report's orders that the
 * layout reader must be the one that is wrong.
 *
 * A model slips on an order or two; a layout the reader no longer knows breaks
 * it everywhere at once. On 21/10/2026 the Deliveries report gained column
 * headings and the reader named all 17 of its customers "U/M". Importing its
 * reading and flagging all 17 would leave a dispatcher retyping them; the AI's
 * reading is imported instead, still flagged order by order. On the benchmark,
 * on layouts the reader knows, no model that misread anything came near this
 * share — luna's worst run differed on 8 of 38.
 */
export const LAYOUT_CHANGED_SHARE = 0.3;
const LAYOUT_CHANGED_MIN_ORDERS = 3;

export function layoutChanged(ordersDiffering: number, orders: number): boolean {
  return ordersDiffering >= LAYOUT_CHANGED_MIN_ORDERS && ordersDiffering / Math.max(orders, 1) >= LAYOUT_CHANGED_SHARE;
}

/** How the report names itself, for messages shown to a person. */
export const REPORT_LABELS: Record<SpruceReportType, string> = {
  ORDER_SUMMARY: 'Customer Order Summary',
  ITEM_TRACKING: 'Sales Order Item Tracking',
  DELIVERY: 'delivery run sheet',
};
