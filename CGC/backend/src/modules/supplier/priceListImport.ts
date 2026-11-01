/**
 * Plans a supplier price list against the rates already stored, without
 * writing anything.
 *
 * The client is sending price lists for every material supplier. Loading one
 * wrongly means paying the wrong price, so the file is read, every row checked
 * and the effect of every row shown before anything is saved:
 *
 *   CREATE      a new rate for a product (or unit) with no rate yet
 *   SUPERSEDE   a new price; the current one is closed the day before
 *   CORRECT     the same start date as a stored rate, with different values
 *   UNCHANGED   nothing to do
 *   ERROR       the row cannot be saved, and why
 *
 * The commit re-runs this same plan and saves it only if it is exactly what the
 * preview showed, and only if no row has an error: all or nothing.
 *
 * Pure: the caller loads the stored rates and the file's rows.
 */
import { createHash } from 'node:crypto';
import { normaliseUnit, type CanonicalUnit } from '../../lib/units.js';
import {
  parseIsoDate,
  parseRate,
  planRateChange,
  rateKey,
  resolveRateUnit,
  type PeriodRate,
  type RateFieldChange,
  type TonMeaning,
} from './rateRules.js';

/** The template's columns, in order. The supplier is chosen on the page. */
export const PRICE_LIST_COLUMNS = [
  'product',
  'spruce_item_code',
  'supplier_item_code',
  'unit',
  'rate',
  'effective_from',
  'effective_to',
  'notes',
] as const;

export type PriceListColumn = (typeof PRICE_LIST_COLUMNS)[number];

const REQUIRED_COLUMNS: PriceListColumn[] = ['product', 'unit', 'rate', 'effective_from'];

/**
 * Header spellings accepted for each column, compared without case, spaces,
 * underscores or punctuation. Only obvious synonyms: a header nobody expected
 * is reported, not guessed at.
 */
const HEADER_ALIASES: Record<string, PriceListColumn> = {
  product: 'product',
  productname: 'product',
  cgcproduct: 'product',
  description: 'product',
  spruceitemcode: 'spruce_item_code',
  spruceitem: 'spruce_item_code',
  spruceitemnumber: 'spruce_item_code',
  sprucecode: 'spruce_item_code',
  supplieritemcode: 'supplier_item_code',
  supplieritem: 'supplier_item_code',
  suppliercode: 'supplier_item_code',
  unit: 'unit',
  uom: 'unit',
  rate: 'rate',
  price: 'rate',
  unitprice: 'rate',
  effectivefrom: 'effective_from',
  startdate: 'effective_from',
  from: 'effective_from',
  effectiveto: 'effective_to',
  enddate: 'effective_to',
  to: 'effective_to',
  notes: 'notes',
  note: 'notes',
};

const MAX_PRODUCT_CHARS = 200;
const MAX_CODE_CHARS = 50;
const MAX_NOTES_CHARS = 500;

export type PriceListAction = 'CREATE' | 'SUPERSEDE' | 'CORRECT' | 'UNCHANGED' | 'ERROR';

export interface PriceListRowValue {
  productName: string;
  unit: string;
  canonicalUnit: CanonicalUnit;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Blank optional cells are undefined: a correction keeps what is stored. */
  notes?: string;
  spruceItemCode?: string;
  supplierItemCode?: string;
}

export interface PriceListRowError {
  code: string;
  message: string;
}

export interface PlannedPriceListRow {
  /** The row number in the file, header included, as Excel shows it. */
  rowNumber: number;
  input: Record<PriceListColumn, string>;
  value: PriceListRowValue | null;
  action: PriceListAction;
  errors: PriceListRowError[];
  /** One plain sentence for the preview. */
  message: string;
  supersedes?: { rateId: string; rate: number; effectiveFrom: string; effectiveTo: string | null; closeOn: string };
  corrects?: { rateId: string; changes: RateFieldChange[] };
  unchanged?: { rateId: string };
}

export interface PriceListPlan {
  rows: PlannedPriceListRow[];
  counts: Record<PriceListAction, number>;
  /** Problems with the file as a whole, e.g. a missing column. */
  fileErrors: string[];
  /** Headers that are not template columns; their cells are ignored. */
  ignoredColumns: string[];
  /** Whether a row says "ton" and the person has not said which ton. */
  needsTonChoice: boolean;
  /** True when there is something to save and nothing is in error. */
  canCommit: boolean;
}

export interface PriceListOptions {
  /** What "ton" means in this file, chosen by the person on the preview. */
  tonMeans?: TonMeaning | null;
}

function headerKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function emptyCounts(): Record<PriceListAction, number> {
  return { CREATE: 0, SUPERSEDE: 0, CORRECT: 0, UNCHANGED: 0, ERROR: 0 };
}

/** Maps the header row to template columns. */
export function readHeader(header: string[]): {
  columns: Map<PriceListColumn, number>;
  missing: PriceListColumn[];
  repeated: PriceListColumn[];
  ignored: string[];
} {
  const columns = new Map<PriceListColumn, number>();
  const repeated: PriceListColumn[] = [];
  const ignored: string[] = [];

  header.forEach((cell, index) => {
    const text = (cell ?? '').replace(/^﻿/, '').trim();
    if (!text) return;
    const column = HEADER_ALIASES[headerKey(text)];
    if (!column) {
      ignored.push(text);
      return;
    }
    if (columns.has(column)) repeated.push(column);
    else columns.set(column, index);
  });

  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  return { columns, missing, repeated, ignored };
}

function optionalText(raw: string, max: number, label: string, errors: PriceListRowError[]): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (text.length > max) {
    errors.push({ code: 'TOO_LONG', message: `${label} is longer than ${max} characters.` });
    return undefined;
  }
  return text;
}

/** Checks one row on its own: required values, unit, price and dates. */
export function validatePriceListRow(
  input: Record<PriceListColumn, string>,
  options: PriceListOptions = {}
): { value: PriceListRowValue | null; errors: PriceListRowError[] } {
  const errors: PriceListRowError[] = [];

  const productName = input.product.trim().replace(/\s+/g, ' ');
  if (!productName) errors.push({ code: 'MISSING_PRODUCT', message: 'Product is missing.' });
  else if (productName.length > MAX_PRODUCT_CHARS) {
    errors.push({ code: 'TOO_LONG', message: `Product is longer than ${MAX_PRODUCT_CHARS} characters.` });
  }

  const unit = resolveRateUnit(input.unit, options.tonMeans);
  if (!unit.ok) errors.push({ code: unit.code, message: unit.message });

  const rateText = input.rate.trim();
  const rate = rateText ? parseRate(rateText) : null;
  if (!rateText) errors.push({ code: 'MISSING_RATE', message: 'Rate is missing.' });
  else if (rate === null) {
    errors.push({ code: 'BAD_RATE', message: `"${rateText}" is not a price. Write it like 18.50, before HST.` });
  }

  const fromText = input.effective_from.trim();
  const effectiveFrom = fromText ? parseIsoDate(fromText) : null;
  if (!fromText) errors.push({ code: 'MISSING_FROM', message: 'effective_from is missing.' });
  else if (!effectiveFrom) {
    errors.push({ code: 'BAD_DATE', message: `effective_from "${fromText}" is not a date. Use YYYY-MM-DD, e.g. 2026-11-01.` });
  }

  const toText = input.effective_to.trim();
  const effectiveTo = toText ? parseIsoDate(toText) : null;
  if (toText && !effectiveTo) {
    errors.push({ code: 'BAD_DATE', message: `effective_to "${toText}" is not a date. Use YYYY-MM-DD, or leave it blank.` });
  }
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    errors.push({ code: 'DATES_REVERSED', message: 'effective_to is before effective_from.' });
  }

  const spruceItemCode = optionalText(input.spruce_item_code, MAX_CODE_CHARS, 'spruce_item_code', errors);
  const supplierItemCode = optionalText(input.supplier_item_code, MAX_CODE_CHARS, 'supplier_item_code', errors);
  const notes = optionalText(input.notes, MAX_NOTES_CHARS, 'notes', errors);

  if (errors.length > 0 || !unit.ok || rate === null || !effectiveFrom) return { value: null, errors };

  return {
    value: {
      productName,
      unit: unit.label,
      canonicalUnit: unit.canonical,
      rate,
      effectiveFrom,
      effectiveTo,
      ...(notes !== undefined ? { notes } : {}),
      ...(spruceItemCode !== undefined ? { spruceItemCode } : {}),
      ...(supplierItemCode !== undefined ? { supplierItemCode } : {}),
    },
    errors,
  };
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

const FIELD_LABELS: Record<RateFieldChange['field'], string> = {
  productName: 'product',
  unit: 'unit',
  rate: 'rate',
  effectiveTo: 'end date',
  notes: 'notes',
  spruceItemCode: 'Spruce item code',
  supplierItemCode: 'supplier item code',
};

function describeChange(change: RateFieldChange): string {
  const show = (value: string | number | null) =>
    value === null || value === '' ? 'blank' : change.field === 'rate' ? money(Number(value)) : String(value);
  return `${FIELD_LABELS[change.field]} ${show(change.from)} → ${show(change.to)}`;
}

/**
 * The whole plan for one supplier's file.
 *
 * `table` is the sheet as read (header first) and `rowNumbers` the file row of
 * each entry; `stored` is every rate the supplier has now.
 *
 * Rows for the same product and unit are planned in date order against the
 * stored rates plus the rows already planned, so a file can carry this year's
 * and next year's price as long as the first one ends before the second starts.
 */
export function planPriceList(
  table: string[][],
  rowNumbers: number[],
  stored: PeriodRate[],
  options: PriceListOptions = {}
): PriceListPlan {
  const plan: PriceListPlan = {
    rows: [],
    counts: emptyCounts(),
    fileErrors: [],
    ignoredColumns: [],
    needsTonChoice: false,
    canCommit: false,
  };

  if (table.length === 0) {
    plan.fileErrors.push('The file has no rows.');
    return plan;
  }

  const header = readHeader(table[0]!);
  plan.ignoredColumns = header.ignored;
  if (header.missing.length > 0) {
    plan.fileErrors.push(
      `Missing column${header.missing.length === 1 ? '' : 's'}: ${header.missing.join(', ')}. ` +
        `Start from the template: ${PRICE_LIST_COLUMNS.join(', ')}.`
    );
  }
  if (header.repeated.length > 0) {
    plan.fileErrors.push(`Column${header.repeated.length === 1 ? '' : 's'} given twice: ${header.repeated.join(', ')}.`);
  }
  if (table.length === 1) plan.fileErrors.push('The file has a header but no prices.');
  if (plan.fileErrors.length > 0) return plan;

  const cell = (row: string[], column: PriceListColumn) => {
    const index = header.columns.get(column);
    return index === undefined ? '' : (row[index] ?? '');
  };

  for (let i = 1; i < table.length; i++) {
    const row = table[i]!;
    const input = Object.fromEntries(PRICE_LIST_COLUMNS.map((c) => [c, cell(row, c)])) as Record<PriceListColumn, string>;
    if (PRICE_LIST_COLUMNS.every((c) => input[c].trim() === '')) continue;

    const { value, errors } = validatePriceListRow(input, options);
    if (errors.some((e) => e.code === 'AMBIGUOUS_TON')) plan.needsTonChoice = true;
    plan.rows.push({
      rowNumber: rowNumbers[i] ?? i + 1,
      input,
      value,
      action: errors.length > 0 ? 'ERROR' : 'UNCHANGED',
      errors,
      message: '',
    });
  }

  if (plan.rows.length === 0) plan.fileErrors.push('The file has a header but no prices.');

  // The same product, unit and start twice in one file: the second is refused,
  // because which one was meant cannot be told.
  const firstSeen = new Map<string, number>();
  for (const row of plan.rows) {
    if (!row.value) continue;
    const key = `${rateKey(row.value.productName, row.value.canonicalUnit)}|${row.value.effectiveFrom}`;
    const first = firstSeen.get(key);
    if (first !== undefined) {
      row.errors.push({ code: 'DUPLICATE', message: `Same product, unit and start date as row ${first}.` });
      row.action = 'ERROR';
    } else {
      firstSeen.set(key, row.rowNumber);
    }
  }

  // Working copy of the stored rates, grouped by product and unit. Copies, so
  // planning a supersede does not alter what the caller passed in.
  const state = new Map<string, PeriodRate[]>();
  for (const rate of stored) {
    const key = rateKey(rate.productName, normaliseUnit(rate.unit));
    const group = state.get(key) ?? [];
    group.push({ ...rate });
    state.set(key, group);
  }

  const toPlan = plan.rows
    .filter((row) => row.value && row.errors.length === 0)
    .sort((a, b) => {
      const ka = rateKey(a.value!.productName, a.value!.canonicalUnit);
      const kb = rateKey(b.value!.productName, b.value!.canonicalUnit);
      return ka === kb ? a.value!.effectiveFrom.localeCompare(b.value!.effectiveFrom) : ka.localeCompare(kb);
    });

  for (const row of toPlan) {
    const value = row.value!;
    const key = rateKey(value.productName, value.canonicalUnit);
    const group = state.get(key) ?? [];
    state.set(key, group);

    const decision = planRateChange(
      {
        productName: value.productName,
        unit: value.unit,
        rate: value.rate,
        effectiveFrom: value.effectiveFrom,
        effectiveTo: value.effectiveTo,
        notes: value.notes,
        spruceItemCode: value.spruceItemCode,
        supplierItemCode: value.supplierItemCode,
      },
      group
    );

    const asRate = (): PeriodRate => ({
      id: `row-${row.rowNumber}`,
      productName: value.productName,
      unit: value.unit,
      rate: value.rate,
      effectiveFrom: value.effectiveFrom,
      effectiveTo: value.effectiveTo,
      notes: value.notes ?? null,
      spruceItemCode: value.spruceItemCode ?? null,
      supplierItemCode: value.supplierItemCode ?? null,
      fileRow: row.rowNumber,
    });

    switch (decision.action) {
      case 'CREATE':
        row.action = 'CREATE';
        row.message = `New rate: ${money(value.rate)} / ${value.unit} from ${value.effectiveFrom}${value.effectiveTo ? ` to ${value.effectiveTo}` : ''}.`;
        group.push(asRate());
        break;
      case 'SUPERSEDE': {
        const old = decision.supersedes;
        row.action = 'SUPERSEDE';
        row.supersedes = {
          rateId: old.id,
          rate: old.rate,
          effectiveFrom: old.effectiveFrom,
          effectiveTo: old.effectiveTo,
          closeOn: decision.closeOn,
        };
        row.message =
          `New price ${money(value.rate)} from ${value.effectiveFrom}. ` +
          `The current ${money(old.rate)} ends ${decision.closeOn} and stays on record for older invoices.`;
        old.effectiveTo = decision.closeOn;
        old.fileRow = row.rowNumber;
        group.push(asRate());
        break;
      }
      case 'CORRECT':
        row.action = 'CORRECT';
        row.corrects = { rateId: decision.corrects.id, changes: decision.changes };
        row.message = `Corrects the rate from ${value.effectiveFrom}: ${decision.changes.map(describeChange).join('; ')}.`;
        Object.assign(decision.corrects, asRate(), { id: decision.corrects.id });
        break;
      case 'UNCHANGED':
        row.action = 'UNCHANGED';
        row.unchanged = { rateId: decision.rate.id };
        row.message = `Already on record: ${money(decision.rate.rate)} / ${decision.rate.unit} from ${decision.rate.effectiveFrom}.`;
        break;
      case 'ERROR':
        row.action = 'ERROR';
        row.errors.push({ code: decision.code, message: decision.message });
        break;
    }
  }

  for (const row of plan.rows) {
    if (row.errors.length > 0) {
      row.action = 'ERROR';
      row.message = row.errors.map((e) => e.message).join(' ');
    }
    plan.counts[row.action]++;
  }

  const changes = plan.counts.CREATE + plan.counts.SUPERSEDE + plan.counts.CORRECT;
  plan.canCommit = plan.fileErrors.length === 0 && plan.counts.ERROR === 0 && changes > 0;
  return plan;
}

/** Hash of the file's bytes, so the commit can tell it got the same file. */
export function fileHashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * A fingerprint of what the plan would write.
 *
 * The preview hands this to the page and the commit recomputes it. If anything
 * changed in between (another person saved a rate, a different file, a
 * different "ton" choice), the fingerprints differ and nothing is written: the
 * person is shown the new preview instead of a result they never saw.
 */
export function planToken(supplierId: string, fileHash: string, tonMeans: TonMeaning | null | undefined, plan: PriceListPlan): string {
  const essence = plan.rows.map((row) => [
    row.rowNumber,
    row.action,
    row.value ? [row.value.productName, row.value.unit, row.value.rate, row.value.effectiveFrom, row.value.effectiveTo] : null,
    row.supersedes
      ? [row.supersedes.rateId, row.supersedes.rate, row.supersedes.effectiveFrom, row.supersedes.effectiveTo, row.supersedes.closeOn]
      : null,
    row.corrects ? [row.corrects.rateId, row.corrects.changes] : null,
    row.unchanged ? row.unchanged.rateId : null,
    row.errors.map((e) => e.code),
  ]);
  return createHash('sha256')
    .update(JSON.stringify([supplierId, fileHash, tonMeans ?? null, essence]))
    .digest('hex');
}
