/**
 * The rules for one agreed rate, kept pure so they can be tested without a
 * database and shared by the single-rate form and the price-list import.
 *
 * A rate is one price for one product, in one unit, over one period. Two rates
 * are "the same rate" when they share supplier, product (compared after
 * normalising the wording) and canonical unit; they may then differ only by
 * period, and their periods must not overlap. A new price closes the previous
 * period the day before it starts instead of overwriting it, so an invoice
 * dated earlier is still checked against the price that applied then.
 *
 * Dates are `YYYY-MM-DD` strings throughout: the columns are SQL dates, and a
 * string cannot drift by a time zone the way a Date can.
 */
import { normaliseUnit, type CanonicalUnit } from '../../lib/units.js';
import { normalizeProductName } from '../../lib/productName.js';

/** How each comparable unit is stored on a rate. One spelling per unit. */
export const RATE_UNIT_LABELS: Record<CanonicalUnit, string> = {
  TONNE: 'tonne',
  SHORT_TON: 'short ton',
  CUBIC_YARD: 'cy',
  CUBIC_METRE: 'm3',
  EACH: 'each',
  SKID: 'skid',
  LOAD: 'load',
  HOUR: 'hour',
  SQUARE_FOOT: 'sqft',
  KILOGRAM: 'kg',
  POUND: 'lb',
};

/** The units a rate may be entered in, in the order the form offers them. */
export const RATE_UNITS = Object.values(RATE_UNIT_LABELS);

/**
 * Spellings that could be either a metric tonne or a short ton.
 *
 * `units.ts` reads a bare "ton" as a short ton, because that is what the word
 * means. But on Ontario aggregate paperwork it is used loosely for both, and
 * the two differ by about ten percent. When a person is entering a price, the
 * system asks rather than picking one: a price list that says "ton" must be
 * told which ton it means.
 */
const AMBIGUOUS_TON = new Set(['ton', 'tons', 'tn', 'tns']);

export type TonMeaning = 'TONNE' | 'SHORT_TON';

export function unitKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isAmbiguousTon(raw: string | null | undefined): boolean {
  return !!raw && AMBIGUOUS_TON.has(unitKey(raw));
}

export type UnitResolution =
  | { ok: true; canonical: CanonicalUnit; label: string }
  | { ok: false; code: 'MISSING_UNIT' | 'AMBIGUOUS_TON' | 'UNKNOWN_UNIT'; message: string };

export const ACCEPTED_UNITS_TEXT = RATE_UNITS.join(', ');

/** The canonical unit a person meant, or why it cannot be told. */
export function resolveRateUnit(raw: string | null | undefined, tonMeans?: TonMeaning | null): UnitResolution {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, code: 'MISSING_UNIT', message: 'Unit is missing.' };

  if (isAmbiguousTon(text)) {
    if (tonMeans === 'TONNE' || tonMeans === 'SHORT_TON') {
      return { ok: true, canonical: tonMeans, label: RATE_UNIT_LABELS[tonMeans] };
    }
    return {
      ok: false,
      code: 'AMBIGUOUS_TON',
      message: `"${text}" could be a metric tonne or a short ton. Choose which one this price is for.`,
    };
  }

  const canonical = normaliseUnit(text);
  if (!canonical) {
    return {
      ok: false,
      code: 'UNKNOWN_UNIT',
      message: `"${text}" is not a unit the invoice check can compare. Use one of: ${ACCEPTED_UNITS_TEXT}.`,
    };
  }
  return { ok: true, canonical, label: RATE_UNIT_LABELS[canonical] };
}

/** The key two rates share when they are prices for the same thing. */
export function rateKey(productName: string, canonicalUnit: CanonicalUnit | null): string {
  return `${normalizeProductName(productName)}|${canonicalUnit ?? 'UNRECOGNISED'}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date as `YYYY-MM-DD`, or null. */
export function parseIsoDate(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim().replace(/\//g, '-');
  const match = ISO_DATE.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  // 2026-02-30 rolls over to March in Date; refuse rather than move it.
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return null;
  }
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return null;
  return text;
}

export function isoOf(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

export function dateOf(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function dayBefore(iso: string): string {
  const date = dateOf(iso);
  date.setUTCDate(date.getUTCDate() - 1);
  return isoOf(date)!;
}

/**
 * A price as a person wrote it, as a number of dollars.
 *
 * `$1,250.50` and ` 18 ` are fine; `18/t`, `-3` and `1e3` are not. Zero is
 * allowed, for charges a supplier has agreed to waive.
 *
 * A comma is read only as a thousands separator in groups of three. A file
 * saved with a decimal comma (`18,50`, as Excel writes in some locales, often
 * in the same semicolon CSV the reader accepts) is refused rather than read as
 * $1,850.
 */
const MAX_RATE = 1_000_000;

export function parseRate(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 && raw <= MAX_RATE ? raw : null;
  const text = (raw ?? '').trim().replace(/^\$/, '').trim();
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/.test(text)) return null;
  const value = Number(text.replace(/,/g, ''));
  return Number.isFinite(value) && value <= MAX_RATE ? value : null;
}

export interface PeriodRate {
  id: string;
  productName: string;
  unit: string;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  spruceItemCode: string | null;
  supplierItemCode: string | null;
  /** Set when the rate is a row of the file being planned, not a stored rate. */
  fileRow?: number;
}

export interface RateCandidate {
  productName: string;
  unit: string;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Undefined means "keep what is stored" on a correction. */
  notes?: string | null | undefined;
  spruceItemCode?: string | null | undefined;
  supplierItemCode?: string | null | undefined;
}

export interface RateFieldChange {
  field: 'productName' | 'unit' | 'rate' | 'effectiveTo' | 'notes' | 'spruceItemCode' | 'supplierItemCode';
  from: string | number | null;
  to: string | number | null;
}

export type RatePlan =
  | { action: 'CREATE' }
  | { action: 'SUPERSEDE'; supersedes: PeriodRate; closeOn: string }
  | { action: 'CORRECT'; corrects: PeriodRate; changes: RateFieldChange[] }
  | { action: 'UNCHANGED'; rate: PeriodRate }
  | { action: 'ERROR'; code: string; message: string; conflictsWith?: PeriodRate };

function overlaps(a: { effectiveFrom: string; effectiveTo: string | null }, b: { effectiveFrom: string; effectiveTo: string | null }) {
  const aEnd = a.effectiveTo ?? '9999-12-31';
  const bEnd = b.effectiveTo ?? '9999-12-31';
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd;
}

function describe(rate: PeriodRate): string {
  const period = `${rate.effectiveFrom} to ${rate.effectiveTo ?? 'no end date'}`;
  return rate.fileRow ? `row ${rate.fileRow} of this file (${period})` : `the rate ${period}`;
}

/** Field-by-field differences a correction would make. */
function correctionChanges(stored: PeriodRate, next: RateCandidate): RateFieldChange[] {
  const changes: RateFieldChange[] = [];
  const push = (field: RateFieldChange['field'], from: string | number | null, to: string | number | null) => {
    if (from !== to) changes.push({ field, from, to });
  };
  push('rate', stored.rate, next.rate);
  push('effectiveTo', stored.effectiveTo, next.effectiveTo);
  push('productName', stored.productName, next.productName);
  push('unit', stored.unit, next.unit);
  if (next.notes !== undefined) push('notes', stored.notes, next.notes);
  if (next.spruceItemCode !== undefined) push('spruceItemCode', stored.spruceItemCode, next.spruceItemCode);
  if (next.supplierItemCode !== undefined) push('supplierItemCode', stored.supplierItemCode, next.supplierItemCode);
  return changes;
}

/**
 * What saving `next` should do, given the rates already held for the same
 * supplier, product and unit.
 *
 *   - Same start date as a stored rate: a correction of that rate, or
 *     unchanged when nothing differs.
 *   - A later start than an open (or still running) rate: that rate is closed
 *     the day before, and `next` starts a new period. If the price is the same
 *     and both are open-ended, the running rate stays: unchanged, or corrected
 *     with the item codes or notes `next` adds.
 *   - Anything that would overlap another period is refused with a reason, as
 *     is a bounded rate inside a longer one (closing the longer one would leave
 *     no price after the new one ends).
 */
export function planRateChange(next: RateCandidate, sameKey: PeriodRate[]): RatePlan {
  if (next.effectiveTo !== null && next.effectiveTo < next.effectiveFrom) {
    return { action: 'ERROR', code: 'DATES_REVERSED', message: 'effective_to is before effective_from.' };
  }

  const sameStart = sameKey.find((rate) => rate.effectiveFrom === next.effectiveFrom);
  if (sameStart?.fileRow) {
    return {
      action: 'ERROR',
      code: 'DUPLICATE',
      message: `Same product, unit and start date as row ${sameStart.fileRow}.`,
      conflictsWith: sameStart,
    };
  }
  if (sameStart) {
    const clash = sameKey.find((rate) => rate !== sameStart && overlaps(rate, next));
    if (clash) {
      return {
        action: 'ERROR',
        code: 'OVERLAP',
        message: `The new end date overlaps ${describe(clash)}.`,
        conflictsWith: clash,
      };
    }
    const changes = correctionChanges(sameStart, next);
    return changes.length === 0
      ? { action: 'UNCHANGED', rate: sameStart }
      : { action: 'CORRECT', corrects: sameStart, changes };
  }

  const running = sameKey.filter(
    (rate) => rate.effectiveFrom < next.effectiveFrom && (rate.effectiveTo === null || rate.effectiveTo >= next.effectiveFrom)
  );
  if (running.length > 1) {
    return {
      action: 'ERROR',
      code: 'STORED_OVERLAP',
      message: 'The stored rates for this product already overlap each other. Fix them on the Rates page first.',
    };
  }

  const later = sameKey.find((rate) => rate.effectiveFrom > next.effectiveFrom && overlaps(rate, next));
  if (later) {
    return {
      action: 'ERROR',
      code: 'LATER_RATE_EXISTS',
      message:
        `A rate starting ${later.effectiveFrom} already exists. ` +
        `Give this price an end date before ${later.effectiveFrom}, or change that rate instead.`,
      conflictsWith: later,
    };
  }

  const prior = running[0];
  if (!prior) return { action: 'CREATE' };

  if (prior.fileRow) {
    return {
      action: 'ERROR',
      code: 'OVERLAP',
      message: `Overlaps ${describe(prior)}. Give that row an end date before ${next.effectiveFrom}.`,
      conflictsWith: prior,
    };
  }

  // The same price, still open, re-sent with a newer date: it already applies.
  // Item codes or notes it brings are still saved on the running rate (its
  // start date kept): dropped, the rate is never found by the order line's
  // Spruce item code and differently worded lines read "No agreed rate".
  if (prior.effectiveTo === null && next.effectiveTo === null && prior.rate === next.rate) {
    const changes = correctionChanges(prior, { ...next, productName: prior.productName, unit: prior.unit });
    return changes.length === 0 ? { action: 'UNCHANGED', rate: prior } : { action: 'CORRECT', corrects: prior, changes };
  }

  if (next.effectiveTo !== null && (prior.effectiveTo === null || prior.effectiveTo > next.effectiveTo)) {
    return {
      action: 'ERROR',
      code: 'INSIDE_PERIOD',
      message:
        `This falls inside ${describe(prior)}. Ending that rate early would leave no price after ` +
        `${next.effectiveTo}. Remove this end date, or change that rate instead.`,
      conflictsWith: prior,
    };
  }

  return { action: 'SUPERSEDE', supersedes: prior, closeOn: dayBefore(next.effectiveFrom) };
}

/**
 * Whether an edited period overlaps any other rate for the same product and
 * unit. Edits do not supersede anything: changing a period is a correction,
 * so a clash is refused and the person decides.
 */
export function findOverlap(edited: { id: string; effectiveFrom: string; effectiveTo: string | null }, sameKey: PeriodRate[]): PeriodRate | null {
  return sameKey.find((rate) => rate.id !== edited.id && overlaps(rate, edited)) ?? null;
}
