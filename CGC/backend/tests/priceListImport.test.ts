/**
 * The price-list planner and the single-rate rules it shares, without a
 * database. Every supplier, product and price here is invented.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  PRICE_LIST_COLUMNS,
  planPriceList,
  planToken,
  readHeader,
  validatePriceListRow,
} from '../src/modules/supplier/priceListImport.js';
import {
  RATE_UNITS,
  dayBefore,
  isAmbiguousTon,
  parseIsoDate,
  parseRate,
  planRateChange,
  resolveRateUnit,
  type PeriodRate,
} from '../src/modules/supplier/rateRules.js';
import { normaliseUnit } from '../src/lib/units.js';

const HEADER = [...PRICE_LIST_COLUMNS];

function row(values: Partial<Record<(typeof PRICE_LIST_COLUMNS)[number], string>>): string[] {
  return PRICE_LIST_COLUMNS.map((column) => values[column] ?? '');
}

function plan(rows: string[][], stored: PeriodRate[] = [], options = {}) {
  const table = [HEADER, ...rows];
  return planPriceList(table, table.map((_, i) => i + 1), stored, options);
}

function stored(overrides: Partial<PeriodRate> = {}): PeriodRate {
  return {
    id: 'rate-1',
    productName: 'Test Gravel 19mm',
    unit: 'tonne',
    rate: 18,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    notes: null,
    spruceItemCode: null,
    supplierItemCode: null,
    ...overrides,
  };
}

const gravel = (overrides = {}) =>
  row({ product: 'Test Gravel 19mm', unit: 'tonne', rate: '19.50', effective_from: '2026-11-01', ...overrides });

describe('units for a rate', () => {
  it('accepts every unit the invoice check can compare, and stores one spelling for each', () => {
    for (const label of RATE_UNITS) {
      const resolved = resolveRateUnit(label);
      assert.equal(resolved.ok, true, label);
      if (resolved.ok) {
        assert.equal(resolved.label, label);
        assert.equal(normaliseUnit(resolved.label), resolved.canonical, `${label} must read back as itself`);
      }
    }
  });

  it('never guesses which ton a bare "ton" means', () => {
    for (const spelling of ['ton', 'TON', 'Tons', 'tn']) {
      const resolved = resolveRateUnit(spelling);
      assert.equal(resolved.ok, false, spelling);
      if (!resolved.ok) assert.equal(resolved.code, 'AMBIGUOUS_TON');
      assert.equal(isAmbiguousTon(spelling), true);
    }
  });

  it('reads "ton" as the ton the person chose', () => {
    const metric = resolveRateUnit('ton', 'TONNE');
    const short = resolveRateUnit('ton', 'SHORT_TON');
    assert.deepEqual(metric, { ok: true, canonical: 'TONNE', label: 'tonne' });
    assert.deepEqual(short, { ok: true, canonical: 'SHORT_TON', label: 'short ton' });
  });

  it('keeps explicit tonnes and short tons apart without asking', () => {
    assert.equal((resolveRateUnit('MT') as { canonical: string }).canonical, 'TONNE');
    assert.equal((resolveRateUnit('metric tonne') as { canonical: string }).canonical, 'TONNE');
    assert.equal((resolveRateUnit('short ton') as { canonical: string }).canonical, 'SHORT_TON');
  });

  it('refuses units the check cannot compare, and lists the ones it can', () => {
    for (const spelling of ['tm', 'yard', 'meter', 'bag']) {
      const resolved = resolveRateUnit(spelling);
      assert.equal(resolved.ok, false, spelling);
      if (!resolved.ok) {
        assert.equal(resolved.code, 'UNKNOWN_UNIT');
        assert.match(resolved.message, /tonne, short ton, cy/);
      }
    }
  });
});

describe('prices and dates', () => {
  it('reads prices the way people write them, zero included', () => {
    assert.equal(parseRate('18.50'), 18.5);
    assert.equal(parseRate('$1,250.00'), 1250);
    assert.equal(parseRate(' 0 '), 0);
    assert.equal(parseRate(12), 12);
  });

  it('refuses anything that is not a plain price', () => {
    for (const text of ['-3', '18/t', '1e3', 'abc', '', '12.5.1']) {
      assert.equal(parseRate(text), null, text);
    }
    assert.equal(parseRate(Number.NaN), null);
    assert.equal(parseRate(-1), null);
    assert.equal(parseRate(2_000_000), null);
  });

  it('never reads a decimal comma as a thousands separator', () => {
    // "18,50" is $18.50 in a decimal-comma locale; stripping the comma made it
    // $1,850. Only a comma between groups of three digits is a separator.
    for (const text of ['18,50', '1,25', '12,5', '1,2345.00', ',500']) {
      assert.equal(parseRate(text), null, text);
    }
    assert.equal(parseRate('1,250'), 1250);
    assert.equal(parseRate('12,345,678.5'), null, 'over the ceiling');
    assert.equal(parseRate('123,456.78'), 123456.78);
  });

  it('accepts only real calendar dates, written year first', () => {
    assert.equal(parseIsoDate('2026-11-01'), '2026-11-01');
    assert.equal(parseIsoDate('2026/11/01'), '2026-11-01');
    for (const text of ['2026-02-30', '01/11/2026', '11-01-2026', 'Nov 1 2026', '1999-12-31']) {
      assert.equal(parseIsoDate(text), null, text);
    }
  });

  it('dayBefore crosses month and year ends', () => {
    assert.equal(dayBefore('2026-03-01'), '2026-02-28');
    assert.equal(dayBefore('2027-01-01'), '2026-12-31');
  });
});

describe('planning one rate against the stored ones', () => {
  const next = { productName: 'Test Gravel 19mm', unit: 'tonne', rate: 19.5, effectiveFrom: '2026-11-01', effectiveTo: null };

  it('creates a rate for a product with none', () => {
    assert.deepEqual(planRateChange(next, []), { action: 'CREATE' });
  });

  it('closes the open rate the day before a later price starts', () => {
    const decision = planRateChange(next, [stored()]);
    assert.equal(decision.action, 'SUPERSEDE');
    if (decision.action === 'SUPERSEDE') {
      assert.equal(decision.supersedes.id, 'rate-1');
      assert.equal(decision.closeOn, '2026-10-31');
    }
  });

  it('treats the same start date as a correction, listing what changes', () => {
    const decision = planRateChange({ ...next, effectiveFrom: '2026-01-01' }, [stored()]);
    assert.equal(decision.action, 'CORRECT');
    if (decision.action === 'CORRECT') {
      assert.deepEqual(decision.changes, [{ field: 'rate', from: 18, to: 19.5 }]);
    }
  });

  it('reports nothing to do for the same values, or the same open price re-sent later', () => {
    assert.equal(planRateChange({ ...next, effectiveFrom: '2026-01-01', rate: 18 }, [stored()]).action, 'UNCHANGED');
    assert.equal(planRateChange({ ...next, rate: 18 }, [stored()]).action, 'UNCHANGED');
  });

  it('refuses a start before a later stored rate it would overlap', () => {
    const decision = planRateChange({ ...next, effectiveFrom: '2025-06-01' }, [stored()]);
    assert.equal(decision.action, 'ERROR');
    if (decision.action === 'ERROR') assert.equal(decision.code, 'LATER_RATE_EXISTS');
  });

  it('allows an older, bounded period that ends before the stored one starts', () => {
    const decision = planRateChange({ ...next, effectiveFrom: '2025-06-01', effectiveTo: '2025-12-31' }, [stored()]);
    assert.equal(decision.action, 'CREATE');
  });

  it('refuses a bounded price inside an open one, which would leave no price after it', () => {
    const decision = planRateChange({ ...next, effectiveTo: '2026-11-30' }, [stored()]);
    assert.equal(decision.action, 'ERROR');
    if (decision.action === 'ERROR') assert.equal(decision.code, 'INSIDE_PERIOD');
  });

  it('refuses when the stored rates already overlap each other', () => {
    const decision = planRateChange(next, [stored(), stored({ id: 'rate-2', effectiveFrom: '2026-06-01' })]);
    assert.equal(decision.action, 'ERROR');
  });
});

describe('the price-list file', () => {
  it('matches headers without case, spaces or underscores, and names unknown ones', () => {
    const header = readHeader(['Product', 'Spruce Item Code', 'UNIT', 'Price', 'Effective From', 'Colour']);
    assert.equal(header.columns.get('spruce_item_code'), 1);
    assert.equal(header.columns.get('rate'), 3);
    assert.deepEqual(header.missing, []);
    assert.deepEqual(header.ignored, ['Colour']);
  });

  it('refuses a file missing a required column, with the template named', () => {
    const result = planPriceList([['product', 'rate'], ['Test Gravel', '10']], [1, 2], []);
    assert.equal(result.canCommit, false);
    assert.match(result.fileErrors[0] ?? '', /Missing columns: unit, effective_from/);
  });

  it('plans a new rate and a superseding one, with plain messages', () => {
    const result = plan(
      [gravel(), row({ product: 'Test Sand', unit: 'cy', rate: '32', effective_from: '2026-11-01' })],
      [stored()]
    );
    assert.equal(result.canCommit, true);
    assert.deepEqual(result.counts, { CREATE: 1, SUPERSEDE: 1, CORRECT: 0, UNCHANGED: 0, ERROR: 0 });
    const superseding = result.rows[0]!;
    assert.equal(superseding.action, 'SUPERSEDE');
    assert.equal(superseding.supersedes?.closeOn, '2026-10-31');
    assert.match(superseding.message, /\$18\.00 ends 2026-10-31 and stays on record/);
    assert.equal(result.rows[1]!.action, 'CREATE');
  });

  it('a product priced in a second unit is a new rate, not a change to the first', () => {
    const result = plan([gravel({ unit: 'skid', rate: '120' })], [stored()]);
    assert.equal(result.rows[0]!.action, 'CREATE');
  });

  it('asks which ton the file means, and blocks saving until it is told', () => {
    const asked = plan([gravel({ unit: 'ton' })]);
    assert.equal(asked.needsTonChoice, true);
    assert.equal(asked.canCommit, false);
    assert.equal(asked.rows[0]!.errors[0]?.code, 'AMBIGUOUS_TON');

    const told = plan([gravel({ unit: 'ton' })], [], { tonMeans: 'TONNE' });
    assert.equal(told.needsTonChoice, false);
    assert.equal(told.canCommit, true);
    assert.equal(told.rows[0]!.value?.unit, 'tonne');
  });

  it('flags every bad cell in a row', () => {
    const result = plan([row({ product: '', unit: 'tm', rate: '-4', effective_from: '01/11/2026' })]);
    const codes = result.rows[0]!.errors.map((e) => e.code).sort();
    assert.deepEqual(codes, ['BAD_DATE', 'BAD_RATE', 'MISSING_PRODUCT', 'UNKNOWN_UNIT']);
    assert.equal(result.counts.ERROR, 1);
    assert.equal(result.canCommit, false);
  });

  it('refuses an end date before the start date', () => {
    const result = plan([gravel({ effective_to: '2026-10-01' })]);
    assert.equal(result.rows[0]!.errors[0]?.code, 'DATES_REVERSED');
  });

  it('refuses the same product, unit and start twice in one file', () => {
    const result = plan([gravel(), gravel({ product: 'TEST GRAVEL 19MM', rate: '20' })]);
    assert.equal(result.rows[1]!.errors[0]?.code, 'DUPLICATE');
    assert.match(result.rows[1]!.message, /row 2/);
  });

  it('allows this year and next year in one file when the first one ends', () => {
    const result = plan(
      [
        gravel({ effective_from: '2027-01-01', rate: '21' }),
        gravel({ effective_from: '2026-11-01', effective_to: '2026-12-31' }),
      ],
      []
    );
    assert.equal(result.canCommit, true, JSON.stringify(result.rows.map((r) => r.message)));
    assert.deepEqual(result.rows.map((r) => r.action), ['CREATE', 'CREATE']);
  });

  it('refuses two open-ended rows for one product in one file', () => {
    const result = plan([gravel(), gravel({ effective_from: '2027-01-01', rate: '21' })]);
    assert.equal(result.rows[1]!.action, 'ERROR');
    assert.match(result.rows[1]!.message, /Overlaps row 2/);
    assert.equal(result.canCommit, false);
  });

  it('does not alter the stored rates it was given', () => {
    const rates = [stored()];
    plan([gravel()], rates);
    assert.equal(rates[0]!.effectiveTo, null);
  });

  it('keeps blank optional cells as "keep what is stored" on a correction', () => {
    const result = plan(
      [gravel({ effective_from: '2026-01-01', rate: '18' })],
      [stored({ notes: 'Agreed by phone', spruceItemCode: 'GRVL19' })]
    );
    assert.equal(result.rows[0]!.action, 'UNCHANGED');
  });

  it('skips blank rows and reports a file with only a header', () => {
    const result = plan([row({})]);
    assert.match(result.fileErrors.join(' '), /no prices/);
  });

  it('has nothing to save when every row is unchanged', () => {
    const result = plan([gravel({ effective_from: '2026-01-01', rate: '18' })], [stored()]);
    assert.equal(result.canCommit, false);
    assert.equal(result.counts.UNCHANGED, 1);
  });

  it('validates a row on its own', () => {
    const { value, errors } = validatePriceListRow(
      Object.fromEntries(PRICE_LIST_COLUMNS.map((c) => [c, ''])) as Record<(typeof PRICE_LIST_COLUMNS)[number], string>
    );
    assert.equal(value, null);
    assert.ok(errors.length >= 4);
  });
});

describe('the preview token', () => {
  it('changes when the stored rates, the ton choice or the supplier change', () => {
    const base = plan([gravel()], [stored()]);
    const token = planToken('supplier-a', 'hash', null, base);
    assert.equal(planToken('supplier-a', 'hash', null, plan([gravel()], [stored()])), token);
    assert.notEqual(planToken('supplier-b', 'hash', null, base), token);
    assert.notEqual(planToken('supplier-a', 'hash', 'TONNE', base), token);
    assert.notEqual(planToken('supplier-a', 'hash', null, plan([gravel()], [stored({ effectiveFrom: '2026-02-01' })])), token);
  });
});

describe('the template the page offers', () => {
  it('has exactly the columns the import reads, in order', () => {
    // The template is built in the browser; a column renamed on one side only
    // would make every downloaded template fail to import.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../frontend/src/lib/priceList.js'),
      'utf8'
    );
    const match = /export const TEMPLATE_COLUMNS = \[([^\]]*)\]/.exec(source);
    assert.ok(match, 'TEMPLATE_COLUMNS not found in priceList.js');
    const columns = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(columns, [...PRICE_LIST_COLUMNS]);
  });
});
