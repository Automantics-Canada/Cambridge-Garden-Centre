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
  // No address because the order is missing from the Item Tracking report,
  // the only one that prints addresses: the export's range is the fix.
  'NOT_IN_ITEM_TRACKING',
  'CHECK_ADDRESS',
  'NO_PHONE',
  // Spruce dates the delivery before the order was entered: a typing slip.
  'DELIVERY_BEFORE_ENTRY',
  'DATE_MISMATCH',
  'TOTAL_MISMATCH',
  'AWAITING_SUPPLIER',
  'SMALL_TRUCK',
  'CUSTOMER_ON_SITE',
  'EXTRACTION_CHECK_FAILED',
  // The layout reader and the AI read this order differently: one of them is
  // wrong, and the import's notes say what differs.
  'READ_DIFFERENTLY',
  'NOT_IN_LATEST_REPORT',
  'NOT_OPEN',
  // A quotation in Spruce, not an order: on Item Tracking, entered inside the
  // Order report's range but left off it, and nothing has ever happened to it.
  // The client confirmed (Oct 2026) that this is what such a document is.
  'QUOTE',
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
  /** Left out where the caller does not know it, and then never flagged. */
  phone?: string | null;
  orderDate?: Date | null;
  /** Whether any upload has carried the order in the Item Tracking report. */
  inItemTracking?: boolean;
  /**
   * Whether any upload has carried the order in the Delivery Report, the only
   * report that prints a phone. Until it has, a blank phone is not missing:
   * nothing has had the chance to give it one.
   */
  inDeliveryReport?: boolean;
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
  if (!address) flags.push(state.inItemTracking === false ? 'NOT_IN_ITEM_TRACKING' : 'NO_ADDRESS');
  else if (looksIncomplete(address)) flags.push('CHECK_ADDRESS');

  // Only the Delivery Report prints a phone. An order dated by the other two,
  // or given to a driver before its Delivery Report came, is not missing one.
  if (state.phone !== undefined && state.inDeliveryReport !== false && !state.phone?.trim()) flags.push('NO_PHONE');
  if (state.orderDate && state.deliveryDate < state.orderDate) flags.push('DELIVERY_BEFORE_ENTRY');

  if (TRUCK_LIMITS.test(state.deliveryInstructions ?? '')) flags.push('SMALL_TRUCK');
  if (MEET_DRIVER.test(state.deliveryInstructions ?? '')) flags.push('CUSTOMER_ON_SITE');

  return flags;
}

/**
 * Flags that take an order out of the work: closed in Spruce since, or never
 * an order at all. Neither is waiting to be delivered or collected.
 */
export const CLOSED_FLAGS: readonly OrderFlag[] = ['NOT_OPEN', 'QUOTE'];

/**
 * What decides an order's derived fields: its state, and its flags as they
 * will stand — those stored, less what the caller has just decided again,
 * plus what it found. An object, so that what else comes to decide a pickup
 * (how the order is fulfilled, a dispatcher's choice) joins it here rather
 * than at every call site.
 */
export interface DeriveInput {
  state: OrderState;
  flags: {
    stored: readonly string[];
    /** Flags the caller was in a position to judge now; see `batchFlags`. */
    decided?: readonly OrderFlag[];
    /** Of those, the ones it set. */
    fresh?: readonly OrderFlag[];
  };
}

function standingFlags(flags: DeriveInput['flags']): OrderFlag[] {
  return combineFlags(flags.stored, flags.decided ?? [], flags.fresh ?? []);
}

/**
 * Whether the customer collects the order, for `OrderDocument.isPickup`.
 *
 * The import and a dispatcher's edit both call this, so the two can never
 * disagree. Before it, the import looked only at what the upload had just
 * decided and an edit only at the stored flags: an order closed by an earlier
 * upload went back to being a pickup at the next upload without the Order
 * report, and stayed a delivery when edited.
 */
export function derivePickup(input: DeriveInput): boolean {
  if (standingFlags(input.flags).some(flag => CLOSED_FLAGS.includes(flag))) return false;
  return isPickupOrder(input.state);
}

/**
 * `stateFlags`, except for a quotation: it is going nowhere, so a missing
 * address or phone on it is nobody's problem.
 */
export function derivedStateFlags(input: DeriveInput, isPickup: boolean): OrderFlag[] {
  return standingFlags(input.flags).includes('QUOTE') ? [] : stateFlags(input.state, isPickup);
}

/** Recomputed from every import, so never carried over from a previous one. */
export const STATE_FLAGS: readonly OrderFlag[] = [
  'AWAITING_SUPPLIER',
  'NO_ADDRESS',
  'NOT_IN_ITEM_TRACKING',
  'CHECK_ADDRESS',
  'NO_PHONE',
  'DELIVERY_BEFORE_ENTRY',
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

/** Ontario HST, which the order summary's total includes and its lines do not. */
const HST = 0.13;

export interface BatchContext {
  /** Which reports this upload contained. */
  reports: ReadonlySet<SpruceReportType>;
  /** The entry-date range the order summary was filtered on, if it was uploaded. */
  orderSummaryRange?: { from: Date; to: Date };
  /**
   * Documents the order summary or delivery report names on a line it could
   * not read. Such a document is on the report all the same: it must not be
   * taken for one the report left out.
   */
  mentioned?: ReadonlySet<string>;
}

/**
 * What has happened to a document before this upload, for telling a
 * quotation from an order that was closed. Anything here means it was an
 * order once.
 */
export interface DocumentHistory {
  /** Every report an upload has carried it in (`OrderDocument.sourceReports`). */
  sourceReports: readonly string[];
  /** A supplier PO on any of its lines, stored or in this upload. */
  hasPo: boolean;
  /** A stop, a driver, an invoice or a ticket on it. */
  hasActivity: boolean;
  /** The stored entry date, for an upload whose Item Tracking prints none. */
  orderDate?: Date | null;
}

const documentNumberOf = (rows: ReportRows): string | undefined =>
  Object.values(rows).flatMap(list => list ?? [])[0]?.documentNumber;

/** Nothing about it says it was ever an order. */
function looksLikeQuote(rows: ReportRows, history: DocumentHistory | undefined): boolean {
  if (!history) return false;
  const everOpen = history.sourceReports.includes('ORDER_SUMMARY') || history.sourceReports.includes('DELIVERY');
  const hasPo = history.hasPo || (rows.ITEM_TRACKING ?? []).some(row => row.poNumber);
  return !everOpen && !hasPo && !history.hasActivity;
}

/**
 * Flags that compare the reports with each other, so can only be decided by
 * an upload that contains the reports being compared.
 *
 * `decided` names every flag this upload was in a position to judge; a flag
 * outside it keeps whatever an earlier upload concluded.
 */
export function batchFlags(
  rows: ReportRows,
  context: BatchContext,
  history?: DocumentHistory
): { flags: OrderFlag[]; decided: OrderFlag[] } {
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
    // A paid order has nothing remaining, so its lines are checked against
    // the total it was paid instead: 2610-721467 was $1,425.98 with tax.
    const paidTotal = remaining === 0 ? summary.find(row => row.totalWithTax !== undefined)?.totalWithTax : undefined;
    const matches = paidTotal !== undefined && lineTotal > 0
      ? Math.abs(lineTotal * (1 + HST) - paidTotal) <= tolerance * (1 + HST)
      : remaining !== undefined && Math.abs(lineTotal - remaining) <= tolerance;
    if (!priced || !matches) {
      flags.push('EXTRACTION_CHECK_FAILED');
    }
  }

  // Open, closed or never an order. A document on the order summary or the
  // delivery report is an open or scheduled order, and one that comes back on
  // either after being taken for a quotation was converted: both flags clear.
  const documentNumber = documentNumberOf(rows);
  const onOpenReport = summary.length > 0 || delivery.length > 0 ||
    (documentNumber !== undefined && (context.mentioned?.has(documentNumber) ?? false));
  if (onOpenReport) {
    decided.push('NOT_OPEN', 'QUOTE');
  } else if (context.reports.has('ORDER_SUMMARY') && context.orderSummaryRange) {
    // The order summary lists only open orders. One entered inside its range
    // that it leaves out was either never an order (a quotation: the client
    // confirmed these are what Item Tracking lists and the summary does not),
    // or was invoiced, closed or voided since. Entered before the range, the
    // summary was never going to list it, so nothing can be concluded and an
    // earlier upload's conclusion stands.
    const entered = firstDate(rows, 'orderDateRaw', ['ITEM_TRACKING']) ?? history?.orderDate ?? undefined;
    const { from, to } = context.orderSummaryRange;
    if (entered && entered >= from && entered <= to) {
      decided.push('NOT_OPEN', 'QUOTE');
      flags.push(looksLikeQuote(rows, history) ? 'QUOTE' : 'NOT_OPEN');
    }
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
