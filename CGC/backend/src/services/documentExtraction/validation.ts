/**
 * Validation and normalisation for everything read off a document.
 *
 * Two rules run through all of it:
 *
 *  1. A value that cannot be validated is rejected, not repaired. The old
 *     pipeline coerced whatever it got — `Number(x) || 0` turned an unreadable
 *     unit price into a free delivery, and a missing unit became "ea" — which
 *     produced ledgers that looked complete and were wrong.
 *  2. Genuine ambiguity lowers confidence rather than picking a winner. A date
 *     that could be March 4th or April 3rd is returned with the North American
 *     reading and a confidence low enough to force a person to confirm it.
 */

import { normaliseUnit } from '../../lib/units.js';

/** Ontario paperwork: purchase orders here are always exactly six digits. */
export const PO_PATTERN = /^\d{6}$/;

/**
 * Widest total this system will accept without a person confirming it.
 *
 * Aggregate invoices at this client run to a few thousand dollars. A six-figure
 * total is far more likely to be two numbers that Textract ran together than a
 * real charge, so it is refused rather than posted.
 */
export const MAX_PLAUSIBLE_TOTAL_CAD = 1_000_000;

export interface Validated<T> {
  ok: boolean;
  value: T | null;
  reason: string | null;
  /** Multiplier applied to the reader's own confidence, 0..1. */
  confidenceFactor: number;
}

function ok<T>(value: T, confidenceFactor = 1): Validated<T> {
  return { ok: true, value, reason: null, confidenceFactor };
}

function fail<T>(reason: string): Validated<T> {
  return { ok: false, value: null, reason, confidenceFactor: 0 };
}

// ---------------------------------------------------------------------------
// Numbers and money
// ---------------------------------------------------------------------------

/**
 * Read a number written the way documents write them.
 *
 * Handles thousands separators, a currency symbol, and accounting negatives in
 * parentheses. Returns null rather than NaN or 0 when the text is not a number.
 */
export function parseNumeric(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith('-');
  const digits = trimmed.replace(/[^0-9.]/g, '');
  if (!digits) return null;

  // More than one decimal point means we are looking at something that is not a
  // single number ("12.5.0", a run-together column). Refuse it.
  if ((digits.match(/\./g) || []).length > 1) return null;

  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) return null;

  return negative ? -parsed : parsed;
}

/** A quantity or rate: finite, not negative. Zero is allowed — see below. */
export function validateNonNegativeNumber(
  raw: string | number | null | undefined,
  label: string
): Validated<number> {
  const parsed = parseNumeric(raw);
  if (parsed === null) return fail(`${label} is not a readable number`);
  if (!Number.isFinite(parsed)) return fail(`${label} is not finite`);
  if (parsed < 0) return fail(`${label} is negative`);
  return ok(parsed);
}

/**
 * A quantity must be positive.
 *
 * Zero is accepted for a *rate* (a no-charge line is a real thing) but a
 * delivery of zero tonnes is a failed read, not a delivery.
 */
export function validateQuantity(raw: string | number | null | undefined): Validated<number> {
  const base = validateNonNegativeNumber(raw, 'Quantity');
  if (!base.ok) return base;
  if (base.value === 0) return fail('Quantity is zero');
  return base;
}

export function validateRate(raw: string | number | null | undefined): Validated<number> {
  return validateNonNegativeNumber(raw, 'Unit rate');
}

/** A CAD amount on an invoice: non-negative, finite, and within reason. */
export function validateCadAmount(
  raw: string | number | null | undefined,
  label = 'Amount'
): Validated<number> {
  const base = validateNonNegativeNumber(raw, label);
  if (!base.ok) return base;
  const value = base.value as number;
  if (value > MAX_PLAUSIBLE_TOTAL_CAD) {
    return fail(`${label} of ${value.toFixed(2)} exceeds the plausible range for this account`);
  }
  // Sub-cent precision on a billed amount means the read picked up part of an
  // adjacent column.
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    return fail(`${label} has more precision than cents`);
  }
  return ok(value);
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

/**
 * Six digits, and nothing else.
 *
 * Punctuation and a `PO` prefix are stripped first because they are formatting,
 * but a number of any other length is a different identifier — an invoice
 * number, a phone extension — and is refused rather than padded or truncated.
 */
export function validatePoNumber(raw: string | number | null | undefined): Validated<string> {
  if (raw === null || raw === undefined) return fail('No PO number found');
  const text = String(raw).trim();
  if (!text) return fail('No PO number found');

  const digits = text.replace(/\D/g, '');
  if (!digits) return fail('PO number contains no digits');
  if (!PO_PATTERN.test(digits)) {
    return fail(`PO number must be exactly six digits (read ${digits.length})`);
  }
  return ok(digits);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Accept only units the rate comparison understands.
 *
 * An unrecognised unit is left unresolved on purpose. Defaulting it to "ea" —
 * which is what happened before — silently made every tonne-priced line
 * comparable against a per-each rate.
 */
export function validateUnit(raw: string | null | undefined): Validated<string> {
  if (!raw) return fail('No unit of measure found');
  const text = String(raw).trim();
  if (!text) return fail('No unit of measure found');

  const canonical = normaliseUnit(text);
  if (!canonical) {
    return fail(`Unit "${truncateForMessage(text)}" is not a recognised unit of measure`);
  }
  return ok(text);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * How far out a document date may sit before it is treated as a misread.
 *
 * A delivery dated three years from now is a transposed year, not a delivery.
 */
const MAX_FUTURE_DAYS = 30;
const MAX_PAST_DAYS = 365 * 5;

/**
 * Parse a date to `YYYY-MM-DD`.
 *
 * Deliberately does not use `new Date(string)`: that accepts almost anything and
 * silently applies the host timezone, which shifted ticket dates across midnight
 * depending on which machine ran the worker.
 *
 * Confidence is reduced, not the value discarded, when a numeric date could be
 * read either day-first or month-first.
 */
export function validateDate(
  raw: string | Date | null | undefined,
  now: Date = new Date()
): Validated<string> {
  if (raw === null || raw === undefined) return fail('No date found');

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return fail('Date is not valid');
    const parts = toIsoDate(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
    return checkRange(parts, now, 1);
  }

  const text = String(raw).trim();
  if (!text) return fail('No date found');

  // ISO, unambiguous.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) {
    const parts = asParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (!parts) return fail(`Date "${truncateForMessage(text)}" is not a real calendar date`);
    return checkRange(parts, now, 1);
  }

  // Textual month in either order: "15 Jan 2026", "Jan 15, 2026".
  const textual =
    text.match(/^(\d{1,2})\s*[-\s.]\s*([A-Za-z]{3,9})\s*[-\s.,]\s*(\d{2,4})$/) ||
    text.match(/^([A-Za-z]{3,9})\s*[-\s.]\s*(\d{1,2})\s*[-\s.,]\s*(\d{2,4})$/);
  if (textual) {
    const first = textual[1] as string;
    const second = textual[2] as string;
    const yearRaw = Number(textual[3]);
    const monthName = /^[A-Za-z]/.test(first) ? first : second;
    const dayRaw = Number(/^[A-Za-z]/.test(first) ? second : first);
    const month = MONTHS[monthName.toLowerCase()];
    if (!month) return fail(`Month "${truncateForMessage(monthName)}" is not a month name`);
    const parts = asParts(expandYear(yearRaw), month, dayRaw);
    if (!parts) return fail(`Date "${truncateForMessage(text)}" is not a real calendar date`);
    return checkRange(parts, now, 1);
  }

  // All-numeric, separator-agnostic.
  const numeric = text.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const c = Number(numeric[3]);

    // Year-first is unambiguous.
    if ((numeric[1] as string).length === 4) {
      const parts = asParts(a, b, c);
      if (!parts) return fail(`Date "${truncateForMessage(text)}" is not a real calendar date`);
      return checkRange(parts, now, 1);
    }

    const year = expandYear(c);

    // Only one of the two readings can be a real month.
    if (a > 12 && b <= 12) {
      const parts = asParts(year, b, a);
      if (!parts) return fail(`Date "${truncateForMessage(text)}" is not a real calendar date`);
      return checkRange(parts, now, 1);
    }
    if (b > 12 && a <= 12) {
      const parts = asParts(year, a, b);
      if (!parts) return fail(`Date "${truncateForMessage(text)}" is not a real calendar date`);
      return checkRange(parts, now, 1);
    }

    // Both readings are real dates. Month-first is the local convention on the
    // paperwork this system sees, so it is used — but the result is marked
    // uncertain so it reaches the review desk instead of the ledger.
    if (a <= 12 && b <= 12) {
      const parts = asParts(year, a, b);
      if (!parts) return fail(`Date "${truncateForMessage(text)}" is not a real calendar date`);
      return checkRange(parts, now, 0.5);
    }

    return fail(`Date "${truncateForMessage(text)}" is not a real calendar date`);
  }

  return fail(`Date "${truncateForMessage(text)}" is not in a recognised format`);
}

function expandYear(year: number): number {
  if (year >= 100) return year;
  // Two-digit years on this paperwork are always current-century.
  return 2000 + year;
}

function asParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2200) return null;
  // Round-trip through UTC to reject the 31st of a 30-day month.
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return null;
  }
  return toIsoDate(year, month, day);
}

function toIsoDate(year: number, month: number, day: number): string {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function checkRange(isoDate: string, now: Date, confidenceFactor: number): Validated<string> {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayMs = 24 * 60 * 60 * 1000;

  if (parsed > today + MAX_FUTURE_DAYS * dayMs) {
    return fail(`Date ${isoDate} is too far in the future to be a document date`);
  }
  if (parsed < today - MAX_PAST_DAYS * dayMs) {
    return fail(`Date ${isoDate} is too far in the past to be a document date`);
  }
  return ok(isoDate, confidenceFactor);
}

/** `YYYY-MM-DD` to a UTC-midnight Date, for columns that store a timestamp. */
export function isoDateToUtcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

const MAX_TEXT_FIELD = 200;

/** A description, supplier name, or document number: trimmed, bounded, non-empty. */
export function validateText(
  raw: string | null | undefined,
  label: string,
  { minLength = 2 }: { minLength?: number } = {}
): Validated<string> {
  if (raw === null || raw === undefined) return fail(`No ${label.toLowerCase()} found`);
  const collapsed = String(raw).replace(/\s+/g, ' ').trim();
  if (collapsed.length < minLength) return fail(`${label} is too short to be usable`);
  if (collapsed.length > MAX_TEXT_FIELD) {
    return fail(`${label} is longer than a ${label.toLowerCase()} should be`);
  }
  return ok(collapsed);
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** A cent of slack per line, for suppliers who round each line themselves. */
export const LINE_TOTAL_TOLERANCE = 0.01;

/**
 * Does quantity x rate equal the printed line total?
 *
 * A line that fails this has been misread somewhere, and there is no way to
 * know which of the three numbers is wrong — so none of them is corrected.
 */
export function checkLineArithmetic(
  quantity: number | null,
  unitRate: number | null,
  lineTotal: number | null
): { checked: boolean; agrees: boolean; expected: number | null } {
  if (quantity === null || unitRate === null || lineTotal === null) {
    return { checked: false, agrees: false, expected: null };
  }
  const expected = quantity * unitRate;
  const tolerance = Math.max(LINE_TOTAL_TOLERANCE, Math.abs(expected) * 0.005);
  return { checked: true, agrees: Math.abs(expected - lineTotal) <= tolerance, expected };
}

/**
 * Do the line totals add up to something the invoice total could plausibly be?
 *
 * Tax is not modelled here. The billed total legitimately carries HST while the
 * lines do not, so this bounds the total between the bare line sum and the line
 * sum plus Ontario's 13%, and reports anything outside that. The rate-aware
 * check lives in the invoice reconciliation, which knows the negotiated rates.
 */
export function checkTotalPlausibility(
  lineTotals: number[],
  invoiceTotal: number | null
): { checked: boolean; agrees: boolean; lineSum: number } {
  const lineSum = lineTotals.reduce((sum, value) => sum + value, 0);
  if (invoiceTotal === null || lineTotals.length === 0) {
    return { checked: false, agrees: false, lineSum };
  }
  const upperBound = lineSum * 1.13 + 0.05;
  const lowerBound = lineSum - 0.05;
  return {
    checked: true,
    agrees: invoiceTotal >= lowerBound && invoiceTotal <= upperBound,
    lineSum,
  };
}

/**
 * Trim a snippet of document text before it goes into a message a person reads.
 *
 * Validation messages are stored and displayed, so they must not become a side
 * channel for the document's contents.
 */
export function truncateForMessage(text: string, limit = 40): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}
