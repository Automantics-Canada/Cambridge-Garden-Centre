import { parseSpruceDate } from '../../../lib/spruceDate.js';
import type { ParsedSpruceRow, SpruceReportType } from '../spruce/spruceReportTypes.js';
import { classifyLine, deliveryTypeOf } from './lineClass.js';

/**
 * Joins one order's rows from the three Spruce reports into one record.
 *
 * The reports are filtered on different dates and each carries a different
 * part of the order, so they overlap only partly and sometimes disagree. Each
 * field has one report that is believed first, chosen for being the report
 * that actually owns that fact:
 *
 *   delivery date        delivery report → item tracking → order summary
 *   customer name        delivery report (the person, line two) → order summary
 *   phone, route         delivery report only
 *   address, instructions, truck, notes    item tracking only
 *   cashier, prices, margin, SCH flag      order summary only
 *   total with tax       order summary → delivery report
 *
 * The item tracking report never names the customer: it prints "Cash Sales"
 * for walk-in trade where the other two print the person.
 *
 * A field is only ever set from a report that printed it. A report missing
 * from today's upload, or one that left a cell blank, leaves the stored value
 * alone rather than erasing it.
 */

export type ReportRows = Partial<Record<SpruceReportType, ParsedSpruceRow[]>>;

export interface OrderPatch {
  customerName?: string;
  accountCode?: string;
  accountName?: string;
  phone?: string;
  route?: string;
  cashier?: string;
  spruceStatus?: string;
  deliveryFlag?: string;
  totalWithTax?: number;
  remaining?: number;
  remainingDeposit?: number;
  grossMarginPct?: number;
  orderDate?: Date;
  deliveryDate?: Date;
  shippingAddress?: string;
  deliveryInstructions?: string;
  deliveryTruck?: string;
  orderNotes?: string;
}

const DELIVERY_FIRST: SpruceReportType[] = ['DELIVERY', 'ITEM_TRACKING', 'ORDER_SUMMARY'];

/** The first value any of `order`'s reports printed for `field`. */
function firstPrinted<K extends keyof ParsedSpruceRow>(
  rows: ReportRows,
  field: K,
  order: SpruceReportType[]
): ParsedSpruceRow[K] | undefined {
  for (const type of order) {
    const value = rows[type]?.map(row => row[field]).find(v => v !== undefined && v !== '');
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstDate(rows: ReportRows, field: 'orderDateRaw' | 'deliveryDateRaw', order: SpruceReportType[]): Date | undefined {
  for (const type of order) {
    for (const row of rows[type] ?? []) {
      const date = parseSpruceDate(row[field]);
      if (date) return date;
    }
  }
  return undefined;
}

export function mergeOrderFacts(rows: ReportRows): OrderPatch {
  const patch: OrderPatch = {};
  const set = <K extends keyof OrderPatch>(key: K, value: OrderPatch[K] | undefined) => {
    if (value !== undefined) patch[key] = value;
  };

  set('customerName', firstPrinted(rows, 'customerName', ['DELIVERY', 'ORDER_SUMMARY']) || undefined);
  set('accountCode', firstPrinted(rows, 'accountCode', ['ORDER_SUMMARY', 'DELIVERY']));
  set('accountName', firstPrinted(rows, 'accountName', ['DELIVERY']));
  set('phone', firstPrinted(rows, 'phone', ['DELIVERY']));
  set('route', firstPrinted(rows, 'route', ['DELIVERY']));
  set('cashier', firstPrinted(rows, 'cashier', ['ORDER_SUMMARY']));
  set('spruceStatus', firstPrinted(rows, 'spruceStatus', ['ORDER_SUMMARY', 'DELIVERY']));
  set('deliveryFlag', firstPrinted(rows, 'deliveryFlag', ['ORDER_SUMMARY']));
  set('totalWithTax', firstPrinted(rows, 'totalWithTax', ['ORDER_SUMMARY', 'DELIVERY']));
  set('remaining', firstPrinted(rows, 'remaining', ['ORDER_SUMMARY']));
  set('remainingDeposit', firstPrinted(rows, 'remainingDeposit', ['ORDER_SUMMARY']));
  set('grossMarginPct', firstPrinted(rows, 'grossMarginPct', ['ORDER_SUMMARY']));
  set('orderDate', firstDate(rows, 'orderDateRaw', ['ORDER_SUMMARY', 'ITEM_TRACKING']));
  set('deliveryDate', firstDate(rows, 'deliveryDateRaw', DELIVERY_FIRST));
  set('shippingAddress', firstPrinted(rows, 'shippingAddress', ['ITEM_TRACKING']));
  set('deliveryInstructions', firstPrinted(rows, 'deliveryInstructions', ['ITEM_TRACKING']));
  set('deliveryTruck', firstPrinted(rows, 'deliveryTruck', ['ITEM_TRACKING']));
  set('orderNotes', firstPrinted(rows, 'orderNotes', ['ITEM_TRACKING']));

  return patch;
}

// ------------------------------------------------------------------ flags

/**
 * Things a dispatcher should look at. Stored on the order, shown on its card.
 *
 * Kept as plain strings so a new one needs no migration; this list is the
 * vocabulary, and the frontend names each one in words.
 */
export const ORDER_FLAGS = [
  'NO_ADDRESS',
  'CHECK_ADDRESS',
  'DATE_MISMATCH',
  'TOTAL_MISMATCH',
  'AWAITING_SUPPLIER',
  'SMALL_TRUCK',
  'CUSTOMER_ON_SITE',
  'EXTRACTION_CHECK_FAILED',
  'NOT_IN_LATEST_REPORT',
  'NOT_OPEN',
  // A dispatcher corrected a field and Spruce has since said something else.
  // Kept by the order's corrections, never decided by an import.
  'SPRUCE_VALUE_CHANGED',
] as const;

export type OrderFlag = (typeof ORDER_FLAGS)[number];

/** Spruce's stray commas tidied: `90 Dooley Dr,,Kitchener` → `90 Dooley Dr, Kitchener`. */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tidied = raw
    .replace(/\s+/g, ' ')
    .replace(/\s*,[\s,]*/g, ', ')
    .replace(/[\s,]+$/, '')
    .replace(/^[\s,]+/, '')
    .trim();
  return tidied || null;
}

/**
 * An address a driver could not navigate to as written: no house number
 * (`Wellington Project`) or no town (`110 Weir St.N.`). Shown as a prompt to
 * check, never corrected — the yard knows its customers, this code does not.
 */
export function looksIncomplete(normalized: string): boolean {
  return !/^\d/.test(normalized) || !normalized.includes(',');
}

/** Words in an instruction that change which truck can go. */
const TRUCK_LIMITS = /\bsmall truck\b|\bcables?\b|\blow (?:wires?|hanging|clearance)\b/i;

/** Words saying someone will meet the driver, or wants a call first. */
const MEET_DRIVER = /\bon site\b|\bcall before\b/i;

interface LineState {
  itemCode?: string | null;
  description?: string | null;
  poNumber?: string | null;
}

export interface OrderState {
  deliveryDate: Date | null;
  shippingAddress: string | null;
  deliveryInstructions: string | null;
  lines: LineState[];
}

/**
 * Collected from the yard rather than delivered.
 *
 * Only an order with no delivery date can be one. It then counts as a pickup
 * when the address says so, a comment says so, or nothing on it is charged
 * for delivery — an unscheduled order with a delivery charge is a delivery
 * whose date has not been set yet, and must not vanish into the pickup list.
 */
export function isPickupOrder(state: OrderState): boolean {
  if (state.deliveryDate) return false;
  if (/pick\s?up/i.test(state.shippingAddress ?? '')) return true;

  const saysPickup = state.lines.some(
    line => classifyLine(line.itemCode, line.description) === 'COMMENT' && /pick\s?up/i.test(line.description ?? '')
  );
  if (saysPickup) return true;

  return deliveryTypeOf(state.lines) === null;
}

/** The flags that follow from what the order now says, whichever report said it. */
export function stateFlags(state: OrderState, isPickup: boolean): OrderFlag[] {
  const flags: OrderFlag[] = [];

  if (state.lines.some(line => line.poNumber)) flags.push('AWAITING_SUPPLIER');

  // The rest only matter for something that is going out on a truck.
  if (!state.deliveryDate || isPickup) return flags;

  const address = normalizeAddress(state.shippingAddress);
  if (!address) flags.push('NO_ADDRESS');
  else if (looksIncomplete(address)) flags.push('CHECK_ADDRESS');

  if (TRUCK_LIMITS.test(state.deliveryInstructions ?? '')) flags.push('SMALL_TRUCK');
  if (MEET_DRIVER.test(state.deliveryInstructions ?? '')) flags.push('CUSTOMER_ON_SITE');

  return flags;
}

/** Recomputed from every import, so never carried over from a previous one. */
export const STATE_FLAGS: readonly OrderFlag[] = [
  'AWAITING_SUPPLIER',
  'NO_ADDRESS',
  'CHECK_ADDRESS',
  'SMALL_TRUCK',
  'CUSTOMER_ON_SITE',
];

/**
 * How far the order summary's lines may drift from its subtotal.
 *
 * Two dollars, plus the rounding each line carries: Spruce prices to the cent
 * on the page but not in its own sum, so a line is off by up to half a cent
 * per unit. On 734 square feet of pavers that alone is $3.67 — the sample's
 * 712595 is $2.72 out with every line read correctly.
 */
const LINE_TOTAL_TOLERANCE = 2;
const PRICE_ROUNDING_PER_UNIT = 0.005;

export interface BatchContext {
  /** Which reports this upload contained. */
  reports: ReadonlySet<SpruceReportType>;
  /** The entry-date range the order summary was filtered on, if it was uploaded. */
  orderSummaryRange?: { from: Date; to: Date };
}

/**
 * Flags that compare the reports with each other, so can only be decided by
 * an upload that contains the reports being compared.
 *
 * `decided` names every flag this upload was in a position to judge; a flag
 * outside it keeps whatever an earlier upload concluded.
 */
export function batchFlags(rows: ReportRows, context: BatchContext): { flags: OrderFlag[]; decided: OrderFlag[] } {
  const flags: OrderFlag[] = [];
  const decided: OrderFlag[] = [];
  const summary = rows.ORDER_SUMMARY ?? [];
  const delivery = rows.DELIVERY ?? [];

  // Delivery date: every report that printed one must print the same one.
  const present = (Object.keys(rows) as SpruceReportType[]).filter(type => (rows[type]?.length ?? 0) > 0);
  if (present.length >= 2) {
    decided.push('DATE_MISMATCH');
    const dates = new Set(
      present
        .map(type => firstDate(rows, 'deliveryDateRaw', [type]))
        .filter((date): date is Date => date !== undefined)
        .map(date => date.toISOString().slice(0, 10))
    );
    if (dates.size > 1) flags.push('DATE_MISMATCH');
  }

  // Total: the order summary and the delivery report both print it.
  const summaryTotal = summary.find(row => row.totalWithTax !== undefined)?.totalWithTax;
  const deliveryTotal = delivery.find(row => row.totalWithTax !== undefined)?.totalWithTax;
  if (summaryTotal !== undefined && deliveryTotal !== undefined) {
    decided.push('TOTAL_MISMATCH');
    if (Math.abs(summaryTotal - deliveryTotal) > 0.005) flags.push('TOTAL_MISMATCH');
  }

  // The order summary's lines must add up to what it says the order is worth.
  // A line read with the wrong price, or a line missed, shows up here.
  if (summary.length > 0) {
    decided.push('EXTRACTION_CHECK_FAILED');
    const remaining = summary.find(row => row.remaining !== undefined)?.remaining;
    const priced = summary.every(row => row.unitPrice !== undefined);
    const lineTotal = summary.reduce((sum, row) => sum + row.quantity * (row.unitPrice ?? 0), 0);
    const tolerance = LINE_TOTAL_TOLERANCE +
      summary.reduce((sum, row) => sum + Math.abs(row.quantity) * PRICE_ROUNDING_PER_UNIT, 0);
    if (remaining === undefined || !priced || Math.abs(lineTotal - remaining) > tolerance) {
      flags.push('EXTRACTION_CHECK_FAILED');
    }
  }

  // The order summary lists only open orders. One entered inside its date
  // range that it leaves out has been invoiced, closed or voided since.
  if (context.reports.has('ORDER_SUMMARY') && context.orderSummaryRange) {
    decided.push('NOT_OPEN');
    const entered = firstDate(rows, 'orderDateRaw', ['ITEM_TRACKING']);
    const { from, to } = context.orderSummaryRange;
    if (summary.length === 0 && entered && entered >= from && entered <= to) flags.push('NOT_OPEN');
  }

  return { flags, decided };
}

/**
 * The flags to store: what this upload decided, what follows from the order
 * as it now stands, and whatever earlier uploads decided that this one could
 * not. Returned in the vocabulary's order, so a re-import that changes
 * nothing writes nothing new.
 */
export function combineFlags(
  stored: readonly string[],
  decided: readonly OrderFlag[],
  fresh: readonly OrderFlag[]
): OrderFlag[] {
  const replaced = new Set<string>([...decided, ...STATE_FLAGS]);
  const kept = stored.filter((flag): flag is OrderFlag =>
    (ORDER_FLAGS as readonly string[]).includes(flag) && !replaced.has(flag)
  );
  const all = new Set<OrderFlag>([...kept, ...fresh]);
  return ORDER_FLAGS.filter(flag => all.has(flag));
}

/** Adds one flag and keeps every other, for an order nothing new was learned about. */
export function withFlag(stored: readonly string[], flag: OrderFlag): OrderFlag[] {
  const all = new Set<string>([...stored, flag]);
  return ORDER_FLAGS.filter(known => all.has(known));
}
