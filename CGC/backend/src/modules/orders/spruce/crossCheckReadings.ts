import { classifyLine } from '../import/lineClass.js';
import type { ParsedSpruceRow } from './spruceReportTypes.js';

/**
 * Two independent readings of one report, compared line by line.
 *
 * Neither reader is safe alone, and both failures have happened:
 *
 *  - The layout reader is exact while the layout is the one it knows, and
 *    wrong without knowing it when the layout moves. On 21/10/2026 the
 *    Deliveries report gained column headings and it read all 17 of that
 *    day's customers as "U/M" — with nothing unreadable, so nothing flagged.
 *  - The AI reads any layout, and now and then reads a line wrong: a document
 *    number as a delivery date, a skid deposit onto the next order.
 *
 * Where they agree, the reading is right twice over. Where they differ, one of
 * them is wrong and a person is told which order and what, rather than either
 * reader being trusted to have been the right one.
 */

/** One way the two readings differ, said so a dispatcher can check it. */
export interface ReadingDifference {
  documentNumber: string;
  detail: string;
}

export interface CrossCheck {
  /** Lines both readers have, compared field by field. */
  compared: number;
  /** Of those, the lines that agreed on every field. */
  agreed: number;
  differences: ReadingDifference[];
}

/** The fields compared, in the words the dispatcher knows them by. */
const FIELD_NAMES: Partial<Record<keyof ParsedSpruceRow, string>> = {
  itemNumber: 'item code',
  product: 'description',
  quantity: 'quantity',
  unit: 'unit',
  customerName: 'customer',
  accountName: 'account name',
  accountCode: 'account code',
  phone: 'phone',
  route: 'route',
  spruceStatus: 'status',
  deliveryDateRaw: 'delivery date',
  orderDateRaw: 'order date',
  shippingAddress: 'address',
  deliveryInstructions: 'delivery instructions',
  deliveryTruck: 'truck',
  orderNotes: 'order notes',
  vendorName: 'vendor',
  vendorLocation: 'vendor location',
  poNumber: 'PO',
  poValue: 'PO value',
  cashier: 'cashier',
  deliveryFlag: 'delivery flag',
  totalWithTax: 'total',
  remainingDeposit: 'deposit',
  remaining: 'remaining',
  grossMarginPct: 'margin',
  unitPrice: 'unit price',
  unitCost: 'unit cost',
};

/** Facts about the whole order, printed on each of its lines: said once per order. */
const ORDER_FIELDS = new Set<keyof ParsedSpruceRow>([
  'customerName', 'accountName', 'accountCode', 'phone', 'route', 'spruceStatus', 'deliveryDateRaw',
  'orderDateRaw', 'shippingAddress', 'deliveryInstructions', 'deliveryTruck', 'orderNotes', 'cashier',
  'deliveryFlag', 'totalWithTax', 'remainingDeposit', 'remaining', 'grossMarginPct',
]);

/**
 * Text compared by its letters and digits only. A wrapped word read joined
 * up ("gardencentr e.ca" / "gardencentre.ca") or a different space is the same
 * reading, not a difference worth a person's time.
 */
const letters = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    return a !== undefined && b !== undefined && Math.abs(Number(a) - Number(b)) < 0.0001;
  }
  return letters(a) === letters(b);
}

const isComment = (row: ParsedSpruceRow) => classifyLine(row.itemNumber, row.product) === 'COMMENT';

/** How alike two lines of one document are, for pairing them up. */
function likeness(a: ParsedSpruceRow, b: ParsedSpruceRow): number {
  return (letters(a.itemNumber) === letters(b.itemNumber) ? 4 : 0) +
    (Math.abs(a.quantity - b.quantity) < 0.0001 ? 3 : 0) +
    (letters(a.product) === letters(b.product) ? 2 : letters(a.product).slice(0, 12) === letters(b.product).slice(0, 12) ? 1 : 0) +
    (letters(a.unit) === letters(b.unit) ? 1 : 0);
}

/** Below this, two lines are not the same line read twice. */
const SAME_LINE = 5;

const shown = (value: unknown) => (value === undefined || value === '' ? 'nothing' : JSON.stringify(value));

function byDocument(rows: ParsedSpruceRow[]): Map<string, ParsedSpruceRow[]> {
  const map = new Map<string, ParsedSpruceRow[]>();
  for (const row of rows) map.set(row.documentNumber, [...(map.get(row.documentNumber) ?? []), row]);
  return map;
}

/**
 * Compares the layout reader's lines with the AI's.
 *
 * `aiUnsure` names documents some of whose AI lines failed the AI reader's own
 * checks: what the AI left out of those is not evidence against the layout
 * reader, so it is not reported.
 */
export function crossCheckReadings(
  reader: ParsedSpruceRow[],
  ai: ParsedSpruceRow[],
  aiUnsure: ReadonlySet<string> = new Set()
): CrossCheck {
  const differences: ReadingDifference[] = [];
  const said = new Set<string>();
  const note = (documentNumber: string, detail: string) => {
    const key = `${documentNumber}|${detail}`;
    if (said.has(key)) return;
    said.add(key);
    differences.push({ documentNumber, detail });
  };
  let compared = 0;
  let agreed = 0;

  const fromReader = byDocument(reader);
  const fromAi = byDocument(ai);

  for (const documentNumber of new Set([...fromReader.keys(), ...fromAi.keys()])) {
    const left = [...(fromReader.get(documentNumber) ?? [])];
    const right = [...(fromAi.get(documentNumber) ?? [])];

    while (left.length && right.length) {
      let best = { score: -1, i: -1, j: -1 };
      left.forEach((a, i) => right.forEach((b, j) => {
        const score = likeness(a, b);
        if (score > best.score) best = { score, i, j };
      }));
      if (best.score < SAME_LINE) break;
      const a = left.splice(best.i, 1)[0]!;
      const b = right.splice(best.j, 1)[0]!;
      compared++;

      let alike = true;
      for (const [field, name] of Object.entries(FIELD_NAMES) as [keyof ParsedSpruceRow, string][]) {
        if (field === 'product' && isComment(a)) continue;
        if (same(a[field], b[field])) continue;
        alike = false;
        const what = `${name} read as ${shown(a[field])} by the report reader, ${shown(b[field])} by AI`;
        note(documentNumber, ORDER_FIELDS.has(field) ? what : `${a.itemNumber ?? a.product}: ${what}`);
      }
      if (alike) agreed++;
    }

    // A line only the AI found, printed under this order: the layout reader
    // may have missed it.
    for (const b of right) {
      if (isComment(b)) continue;
      note(documentNumber, `${b.itemNumber ?? ''} ${b.product} x ${b.quantity}: found by AI, not by the report reader`.trim());
    }
    // A line only the layout reader found. Unless the AI was unsure of this
    // order, it read the order and did not see this line.
    if (!aiUnsure.has(documentNumber)) {
      for (const a of left) {
        if (isComment(a)) continue;
        note(documentNumber, `${a.itemNumber ?? ''} ${a.product} x ${a.quantity}: found by the report reader, not by AI`.trim());
      }
    }
  }

  return { compared, agreed, differences };
}
