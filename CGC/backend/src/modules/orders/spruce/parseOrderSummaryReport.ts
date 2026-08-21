import { SprucePdfError, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
import {
  clusterRows,
  deriveBands,
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
 * Reads the "Customer Order Summary" report.
 *
 * The layout nests two tables: an order's own row, then a fresh set of item
 * headings, then that order's lines, then the next order. Both tables use their
 * own columns, so each is measured from its own headings.
 *
 * A description too long for its column is continued on the lines beneath it,
 * printed under the description column and nothing else. Those continuations
 * are what OCR merged into whichever row it thought was nearest — which is how
 * an item ended up described as the one three lines below it. Here a line with
 * nothing but description text belongs to the item above it, by construction.
 */

const ORDER_COLUMNS: ColumnSpec[] = [
  { key: 'documentNumber', phrase: 'Order#' },
  { key: 'accountCode', phrase: 'Account' },
  { key: 'customerName', phrase: 'Name' },
  { key: 'job', phrase: 'Job' },
  { key: 'cashier', phrase: 'Cashier' },
  { key: 'branch', phrase: 'Branch' },
  { key: 'status', phrase: 'Status' },
  { key: 'deliveryFlag', phrase: 'Delivery' },
  { key: 'deliveryDate', phrase: 'DelvDate' },
  { key: 'orderDate', phrase: 'Ord' },
  { key: 'remainingDeposit', phrase: 'Rem Dep' },
  { key: 'totalWithTax', phrase: 'Total w/tax' },
  { key: 'grossMargin', phrase: 'GM%' },
  { key: 'remaining', phrase: 'Remaining' },
];

/**
 * Item headings, used to divide a line into three coarse zones.
 *
 * The figures on an item line are not read from bands. Its numeric columns are
 * right-aligned under wide headings, so a value sits nearer the *next* heading
 * than its own — the quantity ordered prints at 18.9 under a "QtyOrd" heading
 * at 17.5, with "U/M" beginning at 19.3 — and no boundary drawn from heading
 * positions alone separates them for both this report and the item-tracking
 * one, whose quantities fall the other side of their heading.
 *
 * The zone boundaries used below are the two with room to spare: item code from
 * description, and description from the figures. Within the figures the columns
 * are read in the order the report prints them, which is what the headings
 * describe anyway. This works because a cell arrives whole, so a description
 * reading "24" x 24" Best Way Standard" is one run and never looks like a
 * quantity.
 */
const ITEM_COLUMNS: ColumnSpec[] = [
  { key: 'itemNumber', phrase: 'Item' },
  { key: 'description', phrase: 'Description' },
  { key: 'quantityOrdered', phrase: 'QtyOrd' },
  { key: 'unit', phrase: 'U/M', occurrence: 0 },
  { key: 'quantityReceived', phrase: 'QtyRecv' },
];

/** A run that is nothing but a number, possibly with thousands separators. */
const BARE_NUMBER = /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/;

/** Spruce prints a dash where a line has no unit of measure. */
const NO_UNIT = /^-+$/;

interface ItemZones {
  /** Left edge of the description column. */
  descriptionFrom: number;
  /** Left edge of the figures, i.e. the end of the description column. */
  figuresFrom: number;
  /**
   * Right edge of the quantity ordered and its unit.
   *
   * Bounded by where quantities *received* begin, so that a line with no
   * quantity ordered is reported as unreadable rather than quietly taking the
   * next numeric column along.
   */
  figuresTo: number;
}

function deriveItemZones(header: ReturnType<typeof findHeaderRow>): ItemZones | null {
  if (!header) return null;

  const item = header.hits.get('itemNumber')?.x;
  const description = header.hits.get('description')?.x;
  const quantity = header.hits.get('quantityOrdered')?.x;
  const received = header.hits.get('quantityReceived')?.x;

  if (item === undefined || description === undefined || quantity === undefined) return null;

  return {
    descriptionFrom: (item + description) / 2,
    figuresFrom: (description + quantity) / 2,
    figuresTo: received ?? Number.POSITIVE_INFINITY,
  };
}

/** The order a row belongs to, carried down the page. */
interface OrderContext {
  documentNumber: string;
  customerName: string;
  orderDateRaw?: string;
  deliveryDateRaw?: string;
}

function isItemHeaderRow(row: TextRow): boolean {
  const texts = row.runs.map(run => run.text.trim().toLowerCase());
  return texts.includes('item') && texts.includes('description');
}

/** An order's own row is the one carrying a document number. */
function documentNumberIn(row: TextRow): string | undefined {
  return row.runs.find(run => DOCUMENT_NUMBER_PATTERN.test(run.text.trim()))?.text.trim();
}

interface ItemLine {
  itemNumber?: string;
  description?: string;
  quantity: number | null;
  unit?: string;
}

/**
 * Splits one item line into its code, description and quantity.
 *
 * The quantity is the first bare number among the figures, and the unit the
 * run after it — that being the order the report prints them in. Both are
 * bounded to the left of the quantity-received column so that a line missing a
 * quantity reads as missing rather than borrowing the next column's.
 */
function readItemLine(row: TextRow, zones: ItemZones): ItemLine {
  const line: ItemLine = { quantity: null };

  const codes: string[] = [];
  const description: string[] = [];
  const figures = [];

  for (const run of row.runs) {
    const text = run.text.trim();
    if (!text) continue;

    if (run.x < zones.descriptionFrom) codes.push(text);
    else if (run.x < zones.figuresFrom) description.push(text);
    else if (run.x < zones.figuresTo) figures.push(text);
  }

  if (codes.length > 0) line.itemNumber = codes.join(' ');
  if (description.length > 0) line.description = description.join(' ').replace(/\s+/g, ' ').trim();

  const quantityAt = figures.findIndex(text => BARE_NUMBER.test(text));
  if (quantityAt >= 0) {
    line.quantity = parseSpruceNumber(figures[quantityAt]);

    const next = figures[quantityAt + 1];
    if (next && !BARE_NUMBER.test(next) && !NO_UNIT.test(next)) line.unit = next;
  }

  return line;
}

export function parseOrderSummaryReport(pages: PdfTextPage[]): ParsedSpruceReport {
  const rows: ParsedSpruceRow[] = [];
  const unreadable: UnreadableSpruceRow[] = [];

  let sawOrderHeader = false;
  // Orders run across page breaks, so the order in hand and the item columns
  // both carry over rather than resetting with each page.
  let order: OrderContext | null = null;
  let zones: ItemZones | null = null;

  for (const page of pages) {
    const pageRows = clusterRows(page.runs);
    if (pageRows.length === 0) continue;

    const orderHeader = findHeaderRow(pageRows, ORDER_COLUMNS);
    if (!orderHeader || orderHeader.hits.size < 4) continue;
    sawOrderHeader = true;

    const orderBands = deriveBands(orderHeader, page.width);
    const pageNumber = page.pageIndex + 1;

    for (const [index, row] of pageRows.entries()) {
      if (row.y <= orderHeader.row.y) continue;
      const rowNumber = index + 1;

      if (isItemHeaderRow(row)) {
        const derived = deriveItemZones(findHeaderRow([row], ITEM_COLUMNS));
        if (derived) zones = derived;
        continue;
      }

      const documentNumber = documentNumberIn(row);
      if (documentNumber) {
        const cells = rowText(row, orderBands);
        order = {
          documentNumber,
          customerName: cells.customerName?.trim() || '',
          ...(cells.orderDate?.trim() ? { orderDateRaw: cells.orderDate.trim() } : {}),
          ...(cells.deliveryDate?.trim() ? { deliveryDateRaw: cells.deliveryDate.trim() } : {}),
        };
        continue;
      }

      if (!zones) continue;

      const { itemNumber, description, quantity, unit } = readItemLine(row, zones);

      // A line with only description text continues the item above it.
      if (!itemNumber && description && quantity === null) {
        const previous = rows[rows.length - 1];
        if (previous) previous.product = `${previous.product} ${description}`.replace(/\s+/g, ' ').trim();
        continue;
      }

      if (!itemNumber && !description && quantity === null) continue;

      if (!order) {
        unreadable.push({
          page: pageNumber,
          row: rowNumber,
          reason: `item line "${itemNumber ?? description ?? ''}" appears before any order`,
        });
        continue;
      }

      const missing: string[] = [];
      if (!description) missing.push('description');
      if (quantity === null) missing.push('quantity');

      if (!description || quantity === null) {
        unreadable.push({
          page: pageNumber,
          row: rowNumber,
          reason: `could not read the ${missing.join(', ')} for document ${order.documentNumber}`,
        });
        continue;
      }

      rows.push({
        documentNumber: order.documentNumber,
        customerName: order.customerName,
        product: description,
        ...(itemNumber ? { itemNumber } : {}),
        quantity,
        ...(unit ? { unit } : {}),
        ...(order.orderDateRaw ? { orderDateRaw: order.orderDateRaw } : {}),
        ...(order.deliveryDateRaw ? { deliveryDateRaw: order.deliveryDateRaw } : {}),
        source: { page: pageNumber, row: rowNumber },
      });
    }
  }

  if (!sawOrderHeader) {
    throw new SprucePdfError(
      'MISSING_HEADERS',
      'Could not find the Order# and Account Name columns in this Customer Order Summary. ' +
        'Export it again from Spruce without changing its columns.'
    );
  }

  // Headings without a single readable line mean a truncated export or a
  // column change mid-report. Importing nothing "successfully" is how a day's
  // orders go missing while the screen says done.
  if (rows.length === 0) {
    throw new SprucePdfError(
      'NO_READABLE_ROWS',
      unreadable.length > 0
        ? `Found the order headings but could not read any of the ${unreadable.length} item line(s) in this ` +
          'Customer Order Summary. Export it again from Spruce without changing its columns.'
        : 'Found the order headings but no item lines under them in this Customer Order Summary. ' +
          'Export it again from Spruce.'
    );
  }

  return { type: 'ORDER_SUMMARY', rows, unreadable };
}
