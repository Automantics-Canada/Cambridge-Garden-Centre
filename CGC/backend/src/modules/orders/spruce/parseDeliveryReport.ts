import { SprucePdfError, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
import { clusterRows, type TextRow } from '../../../lib/pdf/textGeometry.js';
import {
  DOCUMENT_NUMBER_PATTERN,
  parseSpruceNumber,
  type ParsedSpruceReport,
  type ParsedSpruceRow,
  type UnreadableSpruceRow,
} from './spruceReportTypes.js';

/**
 * Reads the delivery run sheet.
 *
 * Unlike the other two reports this one prints no column headings — its only
 * strip of header text is a single run reading the date range and
 * "(Inv / Tkt / Ord) Qty Branch", which locates nothing. There is therefore
 * nothing to measure columns from.
 *
 * So lines are read by what they contain rather than by where their columns
 * are. Every field on this report has an unmistakable shape: a document number,
 * a date, a phone number, a quantity to four decimal places. Reading those
 * shapes is steadier here than guessing boundaries would be, and it does not
 * care if the yard's copy of the report is a little wider or narrower.
 */

/** `08/14/26`. */
const SHORT_DATE = /^\d{2}\/\d{2}\/\d{2}$/;

/** `519-240-0128`, or `(519) 744-7719` as some accounts are keyed. */
const PHONE = /^(?:\d{3}-|\(\d{3}\)\s*)\d{3}-\d{4}$/;

/** A phone extension, which wraps onto the line under the number: `EXT.1`. */
const EXTENSION = /^EXT\.?\s*\d+$/i;

/** A quantity, which this report always prints to four decimal places. */
const QUANTITY = /^\d{1,3}(?:,\d{3})*\.\d{4}$/;

/** A money total, e.g. `1,144.57`. */
const MONEY = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;

interface OrderContext {
  documentNumber: string;
  customerName: string;
  /**
   * The report's one date. It is filtered by delivery date, so this is when
   * the order goes out — orders keyed weeks earlier print today's date here.
   * It was once read as the order date, which dated every earlier order today
   * and left none of them a delivery date at all.
   */
  deliveryDateRaw?: string;
  /** Everything else the order's own row says, copied onto each of its lines. */
  facts: Pick<ParsedSpruceRow, 'accountCode' | 'accountName' | 'phone' | 'route' | 'spruceStatus' | 'totalWithTax'>;
  /** Set once an item line has been seen, after which no name refinement. */
  sawItem: boolean;
}

/**
 * A run that could be a customer's name.
 *
 * Names are letters with ordinary punctuation. Everything else on these lines
 * is furniture: quantities, account fragments, and — the case that motivated
 * this — phone extensions such as `EXT.1`, which sat immediately before the
 * phone number and was being read as the customer in its place, replacing the
 * real name beside it.
 */
function looksLikeName(text: string): boolean {
  return text.length > 1 && /[A-Za-z]/.test(text) && !/\d/.test(text);
}

/** The nearest name-like run strictly before `anchorIndex`. */
function lastNameBefore(texts: string[], anchorIndex: number): string {
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const candidate = texts[i]!;
    if (looksLikeName(candidate)) return candidate;
  }
  return '';
}

/**
 * The customer, taken as the name before the phone number.
 *
 * The line runs account code, then customer, then phone, then total, and the
 * codes beside the customer are branch and account abbreviations rather than
 * anything a person would recognise. Searching backwards for the nearest
 * name-like run steps over extensions and codes instead of taking whichever
 * run happens to sit closest to the phone.
 */
function customerFrom(texts: string[]): string {
  const phoneAt = texts.findIndex(text => PHONE.test(text));
  if (phoneAt > 0) return lastNameBefore(texts, phoneAt);

  const totalAt = texts.findIndex(text => MONEY.test(text));
  if (totalAt > 0) return lastNameBefore(texts, totalAt);

  return '';
}

/** The phone number on an order's row, with an extension if one sits beside it. */
function phoneFrom(texts: string[]): string | undefined {
  const phone = texts.find(text => PHONE.test(text));
  if (!phone) return undefined;

  const extension = texts.find(text => EXTENSION.test(text));
  return extension ? `${phone} ${extension}` : phone;
}

/**
 * The codes between the document number and the customer.
 *
 * The row prints type ("Order"), status ("Sched"), route ("KITCH", often
 * blank) and account ("CASH") in that order. With no headings to measure,
 * they are told apart by position: the account is the code beside the name,
 * and the type and status lead. Anything between those two is the route.
 */
function codesFrom(texts: string[], documentAt: number, customerName: string): OrderContext['facts'] {
  const nameAt = customerName ? texts.indexOf(customerName, documentAt + 1) : -1;
  if (nameAt < 0) return {};

  // Every one of these codes has a letter in it. The job number under the
  // account is a bare `0`, and must never be read as one.
  const codes = texts.slice(documentAt + 1, nameAt).filter(text => /[A-Za-z]/.test(text));
  const facts: OrderContext['facts'] = {};

  const account = codes.pop();
  if (account) facts.accountCode = account;
  // Type and status come as a pair; a row without both is not one this
  // reading understands, and a guessed route is worse than none.
  if (codes.length >= 2) {
    facts.spruceStatus = codes[1]!;
    const route = codes.slice(2).join(' ').trim();
    if (route) facts.route = route;
  }

  return facts;
}

function readOrderRow(row: TextRow, documentNumber: string): OrderContext {
  const texts = row.runs.map(run => run.text.trim()).filter(Boolean);
  const customerName = customerFrom(texts);

  const facts = codesFrom(texts, texts.indexOf(documentNumber), customerName);
  // The name on the order's own row is the account's. For walk-in trade that
  // is "Cash Sales", and the person is on the line beneath.
  if (customerName) facts.accountName = customerName;

  const phone = phoneFrom(texts);
  if (phone) facts.phone = phone;

  const total = [...texts].reverse().find(text => MONEY.test(text));
  const totalValue = parseSpruceNumber(total);
  if (totalValue !== null) facts.totalWithTax = totalValue;

  const context: OrderContext = {
    documentNumber,
    customerName,
    facts,
    sawItem: false,
  };

  const date = texts.find(text => SHORT_DATE.test(text));
  if (date) context.deliveryDateRaw = date;

  return context;
}

interface ItemLine {
  itemNumber?: string;
  description: string;
  quantity: number;
  unit?: string;
}

/**
 * Reads an item line, or returns null when the line is not one.
 *
 * A quantity to four decimal places is what marks an item line; the code sits
 * to its left at the start of the line and the description between them.
 */
function readItemLine(row: TextRow): ItemLine | null {
  const texts = row.runs.map(run => run.text.trim()).filter(Boolean);

  const quantityAt = texts.findIndex(text => QUANTITY.test(text));
  if (quantityAt < 0) return null;

  const quantity = parseSpruceNumber(texts[quantityAt]);
  if (quantity === null) return null;

  const before = texts.slice(0, quantityAt);
  const unit = texts[quantityAt + 1];

  const line: ItemLine = {
    description: before.slice(1).join(' ').replace(/\s+/g, ' ').trim(),
    quantity,
  };

  const code = before[0];
  if (code) line.itemNumber = code;
  // A dash stands in for no unit of measure.
  if (unit && !/^-+$/.test(unit) && !QUANTITY.test(unit)) line.unit = unit;

  return line;
}

/** The strip above the first order, repeated at the top of every page. */
const COLUMN_STRIP = '(inv / tkt / ord)';

/**
 * Where a page's orders begin.
 *
 * The strip naming the report's columns sits directly above them. Falling back
 * to the first document number keeps a page readable if that strip is ever
 * dropped, and returning nothing at all is safe — it only means no furniture is
 * skipped on a page that has none.
 */
function dataStartY(rows: TextRow[]): number {
  const strip = rows.find(row =>
    row.runs.some(run => run.text.toLowerCase().replace(/\s+/g, ' ').includes(COLUMN_STRIP))
  );
  if (strip) return strip.y;

  const firstOrder = rows.find(row => row.runs.some(run => DOCUMENT_NUMBER_PATTERN.test(run.text.trim())));
  // Just above it, so the order row itself is still read.
  return firstOrder ? firstOrder.y - Number.EPSILON : Number.NEGATIVE_INFINITY;
}

export function parseDeliveryReport(pages: PdfTextPage[]): ParsedSpruceReport {
  const rows: ParsedSpruceRow[] = [];
  const unreadable: UnreadableSpruceRow[] = [];

  let sawOrder = false;
  // An order's lines continue across a page break, so context carries over.
  let order: OrderContext | null = null;

  for (const page of pages) {
    const pageNumber = page.pageIndex + 1;
    const pageRows = clusterRows(page.runs);
    const startsAfter = dataStartY(pageRows);

    for (const [index, row] of pageRows.entries()) {
      // Skip the letterhead and page numbering. Without this the branch address
      // at the top of a page reads as a continuation of the last description on
      // the page before it.
      if (row.y <= startsAfter) continue;

      const rowNumber = index + 1;
      const texts = row.runs.map(run => run.text.trim()).filter(Boolean);
      if (texts.length === 0) continue;

      const documentNumber = texts.find(text => DOCUMENT_NUMBER_PATTERN.test(text));
      if (documentNumber) {
        order = readOrderRow(row, documentNumber);
        sawOrder = true;
        continue;
      }

      const item = readItemLine(row);

      if (item) {
        if (!order) {
          unreadable.push({
            page: pageNumber,
            row: rowNumber,
            reason: `item line "${item.itemNumber ?? item.description}" appears before any order`,
          });
          continue;
        }

        order.sawItem = true;

        if (!item.description) {
          unreadable.push({
            page: pageNumber,
            row: rowNumber,
            reason: `could not read the description for document ${order.documentNumber}`,
          });
          continue;
        }

        rows.push({
          documentNumber: order.documentNumber,
          customerName: order.customerName,
          product: item.description,
          ...(item.itemNumber ? { itemNumber: item.itemNumber } : {}),
          quantity: item.quantity,
          ...(item.unit ? { unit: item.unit } : {}),
          ...(order.deliveryDateRaw ? { deliveryDateRaw: order.deliveryDateRaw } : {}),
          ...order.facts,
          source: { page: pageNumber, row: rowNumber },
        });
        continue;
      }

      if (!order) continue;

      // Before the first item, the line under an order names the person behind
      // a trade account — "Cash Sales" above, "Aaron Deal" here — which is the
      // name the yard actually recognises. Only a plausible name may refine
      // it: a line of codes or extensions leaves the customer as read.
      if (!order.sawItem) {
        // A long phone number wraps its extension onto this line.
        const extension = texts.find(text => EXTENSION.test(text));
        if (extension && order.facts.phone && !EXTENSION.test(order.facts.phone.split(' ').pop() ?? '')) {
          order.facts.phone = `${order.facts.phone} ${extension}`;
        }

        for (let i = texts.length - 1; i >= 0; i--) {
          const text = texts[i]!;
          if (text !== '0' && !/^\d+$/.test(text) && looksLikeName(text)) {
            order.customerName = text;
            break;
          }
        }
        continue;
      }

      // Otherwise it continues the description of the item above it.
      const previous = rows[rows.length - 1];
      if (previous && previous.documentNumber === order.documentNumber) {
        previous.product = `${previous.product} ${texts.join(' ')}`.replace(/\s+/g, ' ').trim();
      }
    }
  }

  if (!sawOrder) {
    throw new SprucePdfError(
      'MISSING_HEADERS',
      'Could not find any orders in this delivery report. Export it again from Spruce.'
    );
  }

  // Orders without a single readable line mean a truncated export. Importing
  // nothing "successfully" is how a day's deliveries go missing while the
  // screen says done.
  if (rows.length === 0) {
    throw new SprucePdfError(
      'NO_READABLE_ROWS',
      unreadable.length > 0
        ? `Found ${unreadable.length} unreadable item line(s) and none it could read in this delivery ` +
          'report. Export it again from Spruce.'
        : 'Found orders but no readable item lines in this delivery report. Export it again from Spruce.'
    );
  }

  return { type: 'DELIVERY', rows, unreadable };
}
