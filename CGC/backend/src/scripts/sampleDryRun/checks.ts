/**
 * What a read invoice looks like before anything is matched: which fields
 * came back, whether its lines add up to its total, and which units the
 * matching engine will not recognise.
 *
 * Pure: it takes what the invoice reader returned and returns findings. Used
 * by the sample dry run (scripts/invoiceSampleDryRun.ts) to tell us, from the
 * client's real samples, what the reader misses and which unit spellings
 * suppliers use. Units are only added to lib/units.ts once these samples
 * confirm them, never on a guess.
 */
import { normaliseUnit } from '../../lib/units.js';
import { onSamePo, poKey } from '../../modules/matching/poKey.js';
import type { NormalizedInvoice } from '../../services/extraction/normalize.js';

/** Cents of rounding allowed when lines are added up against a printed total. */
export const TOTAL_TOLERANCE = 0.05;
/** Ontario HST, the rate refreshInvoiceTotalCheck assumes for every supplier. */
export const HST_RATE = 0.13;

/** A line description that is a tax, not something bought. */
const TAX_LINE = /\b(h\.?s\.?t|g\.?s\.?t|p\.?s\.?t|sales\s+tax|tax)\b/i;

/**
 * Fields read per line that are not on every build's schema: the trucking
 * ticket number and service date (WP12) are being added beside this. They are
 * counted when the reader returns them and listed as "not read by this build"
 * when it does not, so the report stays right on either side of that change.
 */
export const OPTIONAL_LINE_FIELDS = ['ticketNumber', 'serviceDate'] as const;

export interface FieldFill {
  field: string;
  filled: number;
  total: number;
}

export interface FillReport {
  header: Array<{ field: string; filled: boolean }>;
  lines: FieldFill[];
  /** Line fields this build's reader does not return at all. */
  notReadByThisBuild: string[];
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return true;
}

/** A line field from the reader's result, or from its raw reply when this build drops it. */
export function lineField(
  invoice: NormalizedInvoice,
  rawLines: ReadonlyArray<Record<string, unknown>> | null,
  index: number,
  field: string
): unknown {
  const line = invoice.lineItems[index] as unknown as Record<string, unknown> | undefined;
  if (line && field in line) return line[field];
  return rawLines?.[index]?.[field];
}

function hasField(invoice: NormalizedInvoice, rawLines: ReadonlyArray<Record<string, unknown>> | null, field: string): boolean {
  return (
    invoice.lineItems.some((line) => field in (line as unknown as Record<string, unknown>)) ||
    (rawLines ?? []).some((line) => field in line)
  );
}

export function fillReport(
  invoice: NormalizedInvoice,
  rawLines: ReadonlyArray<Record<string, unknown>> | null = null
): FillReport {
  const header = [
    { field: 'supplierName', filled: present(invoice.supplierName) },
    { field: 'invoiceNumber', filled: present(invoice.invoiceNumber) },
    { field: 'invoiceDate', filled: present(invoice.invoiceDate) },
    { field: 'poNumber', filled: present(invoice.poNumber) },
    { field: 'totalAmount', filled: present(invoice.totalAmount) },
  ];

  const total = invoice.lineItems.length;
  const count = (pick: (index: number) => unknown): number =>
    invoice.lineItems.reduce((n, _line, index) => n + (present(pick(index)) ? 1 : 0), 0);

  const lines: FieldFill[] = [
    // "Unknown Item" is what normalize writes when nothing was read.
    { field: 'description', filled: count((i) => (invoice.lineItems[i]!.description === 'Unknown Item' ? null : invoice.lineItems[i]!.description)), total },
    { field: 'quantity', filled: count((i) => invoice.lineItems[i]!.quantity), total },
    { field: 'unit', filled: count((i) => invoice.lineItems[i]!.unit), total },
    { field: 'unitPrice', filled: count((i) => invoice.lineItems[i]!.unitPrice), total },
    { field: 'amount', filled: count((i) => invoice.lineItems[i]!.totalPrice), total },
    // A line's own PO, or the invoice's, which production falls back to.
    { field: 'poNumber', filled: count((i) => invoice.lineItems[i]!.poNumber ?? invoice.poNumber), total },
  ];

  const notReadByThisBuild: string[] = [];
  for (const field of OPTIONAL_LINE_FIELDS) {
    if (hasField(invoice, rawLines, field)) {
      lines.push({ field, filled: count((i) => lineField(invoice, rawLines, i, field)), total });
    } else {
      notReadByThisBuild.push(field);
    }
  }
  return { header, lines, notReadByThisBuild };
}

export type TotalsVerdict =
  /** Lines (and any tax lines) add up to the printed total. */
  | 'adds-up'
  /** No tax line, but the lines plus 13% HST make the total. */
  | 'adds-up-with-hst'
  | 'does-not-add-up'
  /** The reader found no total on the invoice. */
  | 'no-total'
  /** At least one line has no amount and no quantity and price to make one. */
  | 'incomplete'
  | 'no-lines';

export interface TotalsCheck {
  verdict: TotalsVerdict;
  /** Sum of the lines that are not tax. */
  subtotal: number;
  /** Sum of lines that read as tax (HST, GST...). */
  taxLines: number;
  /** Tax implied when the total is subtotal plus 13%, else null. */
  impliedHst: number | null;
  printedTotal: number | null;
  /** Printed total minus what the lines make; null without a total. */
  difference: number | null;
  /** Lines with no amount and nothing to compute one from (1-based). */
  linesWithoutAmount: number[];
  /** Lines whose quantity times price is not their amount (1-based). */
  arithmetic: Array<{ line: number; quantityTimesPrice: number; amount: number }>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Whether the invoice's lines add up to its total, before any agreed rate is
 * involved.
 *
 * The schema has no tax field, so tax is found two ways: a line whose
 * description says it is tax, or a total that is exactly the lines plus 13%
 * HST. A gap that is neither is reported as it is, with the difference.
 */
export function totalsCheck(invoice: NormalizedInvoice): TotalsCheck {
  const linesWithoutAmount: number[] = [];
  const arithmetic: TotalsCheck['arithmetic'] = [];
  let subtotal = 0;
  let taxLines = 0;

  invoice.lineItems.forEach((line, index) => {
    const computed =
      line.quantity !== null && line.unitPrice !== null ? round2(line.quantity * line.unitPrice) : null;
    const amount = line.totalPrice ?? computed;
    if (amount === null) {
      linesWithoutAmount.push(index + 1);
      return;
    }
    if (computed !== null && line.totalPrice !== null && Math.abs(computed - line.totalPrice) > TOTAL_TOLERANCE) {
      arithmetic.push({ line: index + 1, quantityTimesPrice: computed, amount: line.totalPrice });
    }
    if (TAX_LINE.test(line.description)) taxLines += amount;
    else subtotal += amount;
  });

  subtotal = round2(subtotal);
  taxLines = round2(taxLines);
  const printedTotal = invoice.totalAmount;
  const base = {
    subtotal,
    taxLines,
    printedTotal,
    linesWithoutAmount,
    arithmetic,
  };

  if (invoice.lineItems.length === 0) return { ...base, verdict: 'no-lines', impliedHst: null, difference: null };
  if (printedTotal === null) return { ...base, verdict: 'no-total', impliedHst: null, difference: null };

  const difference = round2(printedTotal - subtotal - taxLines);
  if (linesWithoutAmount.length > 0) return { ...base, verdict: 'incomplete', impliedHst: null, difference };
  if (Math.abs(difference) <= TOTAL_TOLERANCE) return { ...base, verdict: 'adds-up', impliedHst: null, difference };

  const hst = round2(subtotal * HST_RATE);
  if (taxLines === 0 && Math.abs(printedTotal - subtotal - hst) <= TOTAL_TOLERANCE) {
    return { ...base, verdict: 'adds-up-with-hst', impliedHst: hst, difference: round2(printedTotal - subtotal - hst) };
  }
  return { ...base, verdict: 'does-not-add-up', impliedHst: null, difference };
}

export interface UnitReport {
  /** Units printed that lib/units.ts does not recognise, with the lines carrying them. */
  unknown: Array<{ unit: string; lines: number[] }>;
  /** Lines with no unit at all (1-based). */
  missing: number[];
}

export function unitReport(invoice: NormalizedInvoice): UnitReport {
  const unknown = new Map<string, number[]>();
  const missing: number[] = [];
  invoice.lineItems.forEach((line, index) => {
    if (line.unit === null) {
      missing.push(index + 1);
      return;
    }
    if (normaliseUnit(line.unit) === null) unknown.set(line.unit, [...(unknown.get(line.unit) ?? []), index + 1]);
  });
  return { unknown: [...unknown.entries()].map(([unit, lines]) => ({ unit, lines })), missing };
}

// ---------------------------------------------------------------------------
// What the person who wrote the manifest expected.
// ---------------------------------------------------------------------------

export interface ManifestExpectations {
  supplier?: string | undefined;
  invoiceNumber?: string | undefined;
  poNumbers?: string[] | undefined;
  expectedTotal?: number | undefined;
}

export interface ExpectationResult {
  field: string;
  expected: string | number;
  found: string | number | null;
  ok: boolean;
}

const alnum = (value: string): string => value.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();

/**
 * The manifest's expectations against what was read. `supplierName` is the
 * supplier the invoice would be filed under, or the printed name when it
 * would not be filed under any known one.
 */
export function compareWithManifest(
  invoice: NormalizedInvoice,
  expected: ManifestExpectations,
  supplierName: string | null
): ExpectationResult[] {
  const results: ExpectationResult[] = [];
  if (expected.supplier !== undefined) {
    results.push({
      field: 'supplier',
      expected: expected.supplier,
      found: supplierName,
      ok: supplierName !== null && supplierName.trim().toLowerCase() === expected.supplier.trim().toLowerCase(),
    });
  }
  if (expected.invoiceNumber !== undefined) {
    results.push({
      field: 'invoiceNumber',
      expected: expected.invoiceNumber,
      found: invoice.invoiceNumber,
      ok: invoice.invoiceNumber !== null && alnum(invoice.invoiceNumber) === alnum(expected.invoiceNumber),
    });
  }
  if (expected.expectedTotal !== undefined) {
    results.push({
      field: 'total',
      expected: expected.expectedTotal,
      found: invoice.totalAmount,
      ok: invoice.totalAmount !== null && Math.abs(invoice.totalAmount - expected.expectedTotal) <= 0.01,
    });
  }
  const readPos = [invoice.poNumber, ...invoice.lineItems.map((line) => line.poNumber)].filter(
    (po): po is string => po !== null
  );
  for (const po of expected.poNumbers ?? []) {
    const found = readPos.find((read) => onSamePo(read, po)) ?? null;
    results.push({ field: 'poNumber', expected: po, found, ok: found !== null });
  }
  if (expected.poNumbers && expected.poNumbers.length > 0) {
    // A PO on the invoice that nobody told us about is worth a look: it is
    // either a misread or an order missing from the related records.
    const unexpected = [...new Set(readPos)].filter(
      (read) => poKey(read) !== null && !expected.poNumbers!.some((po) => onSamePo(read, po))
    );
    for (const read of unexpected) results.push({ field: 'unexpectedPo', expected: '(not in the manifest)', found: read, ok: false });
  }
  return results;
}
