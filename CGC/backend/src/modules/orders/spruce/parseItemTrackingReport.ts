import { SprucePdfError, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
import {
  clusterRows,
  deriveBands,
  deriveRowTolerance,
  findHeaderRow,
  rowText,
  type ColumnSpec,
  type TextRow,
} from '../../../lib/pdf/textGeometry.js';
import {
  DOCUMENT_NUMBER_PATTERN,
  parseSpruceNumber,
  type ParsedSpruceReport,
  type ParsedSpruceRow,
  type UnreadableSpruceRow,
} from './spruceReportTypes.js';

/**
 * Reads the "Sales Order Item Tracking" report.
 *
 * This report has more columns than fit across a page, so Spruce splits it
 * *sideways*: the first page carries the leftmost columns, the next page the
 * following ones, and so on, all describing the same rows. Only when those
 * columns run out does it move on to the next batch of rows and repeat the
 * cycle. A document number therefore sits on one page and the purchase order
 * raised against it on the next.
 *
 * Nothing that reads a page on its own can put those back together, which is
 * why OCR could never produce a PO from this report however well it read the
 * pixels. Rows are rejoined here by vertical position: the two halves of a row
 * are printed at the same height on their respective pages.
 */

/** Leftmost columns: who the order is for and where it goes. */
const BAND_ONE: ColumnSpec[] = [
  { key: 'documentNumber', phrase: 'Document' },
  { key: 'deliveryDate', phrase: 'Delivery Date' },
  { key: 'entryDate', phrase: 'Entry Date' },
  { key: 'customerName', phrase: 'Customer Name' },
  { key: 'shippingAddress', phrase: 'Shipping Address' },
  { key: 'deliveryInstructions', phrase: 'Delivery Instructions' },
  { key: 'deliveryTruck', phrase: 'Delivery Truck' },
  { key: 'orderAttachments', phrase: 'Order Attachments' },
];

/** Middle columns: what was ordered, and the PO raised on a vendor for it. */
const BAND_TWO: ColumnSpec[] = [
  { key: 'orderNotes', phrase: 'Order Notes' },
  { key: 'itemNumber', phrase: 'Item Number' },
  { key: 'itemDesc', phrase: 'Item Desc' },
  { key: 'qty', phrase: 'Qty' },
  { key: 'vendor', phrase: 'Vendor' },
  { key: 'vendorLocation', phrase: 'Vendor Location' },
  { key: 'poDocument', phrase: 'PO Document' },
  { key: 'poValue', phrase: 'PO Value' },
  { key: 'poNotes', phrase: 'PO Notes' },
];

/** Trailing columns. Empty on the sample reports, but they still take a page. */
const BAND_THREE: ColumnSpec[] = [
  { key: 'poNotes', phrase: 'PO Notes' },
  { key: 'poAttachments', phrase: 'PO Attachments' },
];

const BANDS = [BAND_ONE, BAND_TWO, BAND_THREE];

interface BandedPage {
  page: PdfTextPage;
  /** 0, 1 or 2. */
  bandIndex: number;
  header: TextRow;
  /** Row y to its cells, for rows below the header. */
  rows: Array<{ y: number; cells: Record<string, string> }>;
}

/**
 * Reads one page under whichever band's headings it matches best.
 *
 * The trailing band repeats a heading from the middle one, so the band with the
 * most matches wins rather than the first that matches at all.
 */
function readPage(page: PdfTextPage): BandedPage | null {
  const rows = clusterRows(page.runs);
  if (rows.length === 0) return null;

  let bandIndex = -1;
  let bestHits = 0;
  let bestHeader: ReturnType<typeof findHeaderRow> = null;

  for (const [index, columns] of BANDS.entries()) {
    const match = findHeaderRow(rows, columns);
    if (match && match.hits.size > bestHits) {
      bestHits = match.hits.size;
      bestHeader = match;
      bandIndex = index;
    }
  }

  // One stray heading word is a title, not a column strip.
  if (!bestHeader || bestHits < 2) return null;

  const bands = deriveBands(bestHeader, page.width);
  const headerY = bestHeader.row.y;

  const dataRows = rows
    .filter(row => row.y > headerY)
    .map(row => ({ y: row.y, cells: rowText(row, bands) }))
    .filter(row => Object.keys(row.cells).length > 0);

  return { page, bandIndex, header: bestHeader.row, rows: dataRows };
}

/**
 * Groups pages into stripes.
 *
 * A stripe is one batch of rows shown across however many pages its columns
 * need. Seeing the leftmost band again means the columns have wrapped round and
 * a new batch of rows has started.
 */
function groupIntoStripes(pages: BandedPage[]): BandedPage[][] {
  const stripes: BandedPage[][] = [];
  let current: BandedPage[] = [];

  for (const page of pages) {
    if (page.bandIndex === 0 && current.length > 0) {
      stripes.push(current);
      current = [];
    }
    current.push(page);
  }
  if (current.length > 0) stripes.push(current);

  return stripes;
}

/**
 * Rejoins the halves of each row within one stripe.
 *
 * The same row is printed at the same height on each of the stripe's pages, so
 * heights are clustered across the whole stripe rather than matched exactly —
 * the two halves agree to well within a row, but insisting on identical
 * coordinates would make the join brittle for the sake of nothing.
 */
function mergeStripe(stripe: BandedPage[]): Array<{ cells: Record<string, string>; page: number; row: number }> {
  const entries = stripe.flatMap(banded =>
    banded.rows.map(row => ({ y: row.y, cells: row.cells, pageIndex: banded.page.pageIndex }))
  );
  if (entries.length === 0) return [];

  const tolerance = deriveRowTolerance(entries.map(entry => entry.y));

  const ordered = [...entries].sort((a, b) => a.y - b.y);
  const merged: Array<{ cells: Record<string, string>; page: number; row: number }> = [];

  let current: Record<string, string> | null = null;
  let currentPage = 0;
  let previousY = ordered[0]!.y;

  for (const entry of ordered) {
    if (current === null || entry.y - previousY > tolerance) {
      if (current) merged.push({ cells: current, page: currentPage, row: merged.length + 1 });
      current = {};
      // Attribute the row to the page carrying its leftmost columns, which is
      // where a person looking for it would turn first.
      currentPage = entry.pageIndex + 1;
    }
    Object.assign(current, entry.cells);
    previousY = entry.y;
  }
  if (current) merged.push({ cells: current, page: currentPage, row: merged.length + 1 });

  return merged;
}

export function parseItemTrackingReport(pages: PdfTextPage[]): ParsedSpruceReport {
  const banded = pages.map(readPage).filter((page): page is BandedPage => page !== null);

  if (!banded.some(page => page.bandIndex === 0)) {
    throw new SprucePdfError(
      'MISSING_HEADERS',
      'Could not find the Document and Customer Name columns in this Sales Order Item Tracking ' +
        'report. Export it again from Spruce without changing its columns.'
    );
  }

  const rows: ParsedSpruceRow[] = [];
  const unreadable: UnreadableSpruceRow[] = [];

  for (const stripe of groupIntoStripes(banded)) {
    for (const { cells, page, row } of mergeStripe(stripe)) {
      const documentNumber = cells.documentNumber?.trim();
      const product = cells.itemDesc?.trim();
      const quantity = parseSpruceNumber(cells.qty);
      const itemNumber = cells.itemNumber?.trim();

      const hasDocumentNumber = Boolean(documentNumber && DOCUMENT_NUMBER_PATTERN.test(documentNumber));
      const hasLineData = Boolean(itemNumber || product || quantity !== null);

      // Page furniture rather than a line that failed to read. The footer's
      // revision stamp prints under the leftmost column, so a row is only
      // treated as an order line when it carries either a real document number
      // or something of an item.
      if (!hasDocumentNumber && !hasLineData) continue;

      const missing: string[] = [];
      if (!hasDocumentNumber) missing.push('document number');
      if (!product) missing.push('description');
      if (quantity === null) missing.push('quantity');

      if (!documentNumber || !hasDocumentNumber || !product || quantity === null) {
        unreadable.push({
          page,
          row,
          reason: `could not read the ${missing.join(', ')}${
            hasDocumentNumber ? ` for document ${documentNumber}` : ''
          }`,
        });
        continue;
      }

      rows.push({
        documentNumber,
        customerName: cells.customerName?.trim() || '',
        product,
        ...(cells.itemNumber?.trim() ? { itemNumber: cells.itemNumber.trim() } : {}),
        quantity,
        ...(cells.entryDate?.trim() ? { orderDateRaw: cells.entryDate.trim() } : {}),
        ...(cells.deliveryDate?.trim() ? { deliveryDateRaw: cells.deliveryDate.trim() } : {}),
        ...(cells.poDocument?.trim() ? { poNumber: cells.poDocument.trim() } : {}),
        ...(cells.vendor?.trim() ? { vendorName: cells.vendor.trim() } : {}),
        ...(cells.shippingAddress?.trim() ? { shippingAddress: cells.shippingAddress.trim() } : {}),
        ...(cells.orderNotes?.trim() ? { orderNotes: cells.orderNotes.trim() } : {}),
        source: { page, row },
      });
    }
  }

  // Headings without a single readable line mean a truncated export or a
  // column change mid-report. Importing nothing "successfully" is how a day's
  // orders go missing while the screen says done.
  if (rows.length === 0) {
    throw new SprucePdfError(
      'NO_READABLE_ROWS',
      unreadable.length > 0
        ? `Found the column headings but could not read any of the ${unreadable.length} item line(s) on this ` +
          'Sales Order Item Tracking report. Export it again from Spruce without changing its columns.'
        : 'Found the column headings but no item lines under them in this Sales Order Item Tracking ' +
          'report. Export it again from Spruce.'
    );
  }

  return { type: 'ITEM_TRACKING', rows, unreadable };
}
