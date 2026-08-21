/**
 * What the Spruce report parsers produce.
 *
 * Spruce exports the same day's work in several report layouts, and the yard
 * uploads whichever one it ran. Each layout carries a different subset of the
 * fields — only the item-tracking report knows the vendor and PO, only the
 * order summary knows unit prices — so the parsers converge on one row shape
 * and leave absent fields undefined rather than inventing them.
 */

export type SpruceReportType =
  /** "Customer Order Summary" — order headers with priced item lines. */
  | 'ORDER_SUMMARY'
  /** "Sales Order Item Tracking" — items with vendor, PO and shipping address. */
  | 'ITEM_TRACKING'
  /** The delivery run sheet — orders with items, phone numbers and totals. */
  | 'DELIVERY';

/**
 * One item line, with whatever its report knows about the order above it.
 *
 * Dates stay as written. Parsing them here would leave a bad date indistinct
 * from an absent one; the importer converts them where it can report a failure
 * against the row it came from.
 */
export interface ParsedSpruceRow {
  /** Spruce document number, e.g. `2608-712589`. The join key between reports. */
  documentNumber: string;
  customerName: string;
  /** Item description. Wrapped and overflowing text is already joined in. */
  product: string;
  /** Spruce item code, e.g. `SOILGRDNA`. */
  itemNumber?: string;
  quantity: number;
  /** Unit of measure as printed. Absent where the report has no such column. */
  unit?: string;
  orderDateRaw?: string;
  deliveryDateRaw?: string;
  /** Purchase order raised on a vendor. Only the item-tracking report has it. */
  poNumber?: string;
  vendorName?: string;
  shippingAddress?: string;
  orderNotes?: string;
  /** Where this came from, for error messages. Both 1-based. */
  source: { page: number; row: number };
}

/** A row that could not be read, kept so it can be reported rather than lost. */
export interface UnreadableSpruceRow {
  page: number;
  row: number;
  reason: string;
}

export interface ParsedSpruceReport {
  type: SpruceReportType;
  rows: ParsedSpruceRow[];
  /**
   * Rows that looked like data but could not be read.
   *
   * Reported rather than dropped: a silently skipped line is how an order goes
   * missing without anyone noticing it went.
   */
  unreadable: UnreadableSpruceRow[];
}

/** Spruce document number, e.g. `2608-712589`. */
export const DOCUMENT_NUMBER_PATTERN = /^\d{4}-\d{6}$/;

/** A quantity as Spruce prints it: four decimal places, optional thousands. */
export const QUANTITY_PATTERN = /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/;

/**
 * Reads a Spruce number, which may carry thousands separators.
 *
 * Returns null rather than NaN or zero so a caller can tell "no quantity" from
 * "a quantity of nothing" — the two mean different things on a delivery.
 */
export function parseSpruceNumber(raw: string | undefined): number | null {
  if (!raw) return null;

  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
