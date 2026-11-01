import { describe, expect, it } from 'vitest';
import {
  RATE_UNITS,
  TEMPLATE_COLUMNS,
  actionLabel,
  buildTemplateCsv,
  changedRateFields,
  isAmbiguousTon,
  isPriceListFile,
  previewRows,
  priceListFileName,
  rateStatus,
  rateUnitValue,
  ratesToCsv,
  summarisePreview,
  validateRateForm,
} from './priceList';

describe('units', () => {
  it('offers no plain "ton"', () => {
    expect(RATE_UNITS.map((u) => u.value)).not.toContain('ton');
    expect(RATE_UNITS[0].value).toBe('tonne');
  });

  it('makes the person choose for a bare "ton" or a unit the check cannot compare', () => {
    expect(isAmbiguousTon('TON')).toBe(true);
    expect(rateUnitValue('ton')).toBe('');
    expect(rateUnitValue('tm')).toBe('');
    expect(rateUnitValue('yard')).toBe('');
  });

  it('maps known spellings to the form value', () => {
    expect(rateUnitValue('MT')).toBe('tonne');
    expect(rateUnitValue('tonnes')).toBe('tonne');
    expect(rateUnitValue('short ton')).toBe('short ton');
    expect(rateUnitValue('SQFT')).toBe('sqft');
    expect(rateUnitValue('ft²')).toBe('sqft');
  });
});

describe('the rate form', () => {
  const original = {
    productName: 'Test Gravel 19mm',
    rate: '18',
    unit: 'tonne',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    notes: null,
  };
  const form = { productName: 'Test Gravel 19mm', rate: '18.00', unit: 'tonne', effectiveFrom: '2026-01-01', effectiveTo: '', notes: '' };

  it('sends only the fields that changed', () => {
    expect(changedRateFields(original, form)).toEqual({});
    expect(changedRateFields(original, { ...form, rate: '19.5' })).toEqual({ rate: 19.5 });
    expect(changedRateFields({ ...original, effectiveTo: '2026-12-31T00:00:00.000Z' }, form)).toEqual({ effectiveTo: '' });
  });

  it('allows a zero price and refuses a missing unit or reversed dates', () => {
    expect(validateRateForm({ ...form, rate: '0' })).toEqual({});
    expect(validateRateForm({ ...form, unit: 'ton' })).toHaveProperty('unit');
    expect(validateRateForm({ ...form, rate: '-1' })).toHaveProperty('rate');
    expect(validateRateForm({ ...form, effectiveTo: '2025-12-31' })).toHaveProperty('effectiveTo');
  });

  it('tells future, current and ended periods apart by calendar day', () => {
    const today = '2026-11-01';
    expect(rateStatus({ effectiveFrom: '2026-12-01T00:00:00.000Z' }, today)).toBe('future');
    expect(rateStatus({ effectiveFrom: '2026-01-01', effectiveTo: '2026-11-01T00:00:00.000Z' }, today)).toBe('current');
    expect(rateStatus({ effectiveFrom: '2026-01-01', effectiveTo: '2026-10-31' }, today)).toBe('ended');
  });
});

describe('the template', () => {
  it('has the import columns in order and no example rows', () => {
    expect(TEMPLATE_COLUMNS).toEqual(['product', 'spruce_item_code', 'supplier_item_code', 'unit', 'rate', 'effective_from', 'effective_to', 'notes']);
    expect(buildTemplateCsv()).toBe('product,spruce_item_code,supplier_item_code,unit,rate,effective_from,effective_to,notes\r\n');
  });

  it('exports current rates in the same format, quoting where needed', () => {
    const csv = ratesToCsv([
      { productName: 'Test Sand', unit: 'cy', rate: '32', effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: null, notes: 'Washed, screened' },
      { productName: 'Test Gravel', unit: 'tonne', rate: 18.5, effectiveFrom: '2026-01-01', effectiveTo: '2026-10-31', spruceItemCode: 'GRVL19' },
    ]);
    expect(csv.split('\r\n')).toEqual([
      TEMPLATE_COLUMNS.join(','),
      'Test Gravel,GRVL19,,tonne,18.5,2026-01-01,2026-10-31,',
      'Test Sand,,,cy,32,2026-11-01,,"Washed, screened"',
      '',
    ]);
  });

  it('names downloads after the supplier', () => {
    expect(priceListFileName('Example Aggregates Ltd.')).toBe('example-aggregates-ltd-price-list.csv');
    expect(isPriceListFile({ name: 'prices.XLSX' })).toBe(true);
    expect(isPriceListFile({ name: 'prices.xls' })).toBe(false);
  });
});

describe('the preview', () => {
  const preview = (counts, rows = [], fileErrors = []) => ({ plan: { counts, rows, fileErrors } });

  it('says what saving would do', () => {
    expect(summarisePreview(preview({ CREATE: 2, SUPERSEDE: 1, CORRECT: 0, UNCHANGED: 3, ERROR: 0 }))).toBe(
      'Saving adds 2 new rates, 1 new price. 3 rows are already on record.'
    );
  });

  it('says nothing is saved while any row has an error', () => {
    expect(summarisePreview(preview({ CREATE: 4, ERROR: 1 }))).toBe('1 row has an error. Nothing is saved until every row is fixed.');
  });

  it('passes file problems through, and says when there is nothing to save', () => {
    expect(summarisePreview(preview({}, [], ['Missing column: unit.']))).toBe('Missing column: unit.');
    expect(summarisePreview(preview({ UNCHANGED: 2 }))).toMatch(/Nothing to save/);
  });

  it('lists errors first and can hide unchanged rows', () => {
    const rows = [
      { rowNumber: 2, action: 'CREATE' },
      { rowNumber: 3, action: 'UNCHANGED' },
      { rowNumber: 4, action: 'ERROR' },
    ];
    expect(previewRows(preview({}, rows)).map((r) => r.rowNumber)).toEqual([4, 2, 3]);
    expect(previewRows(preview({}, rows), { onlyChanges: true }).map((r) => r.rowNumber)).toEqual([4, 2]);
  });

  it('labels each action plainly', () => {
    expect(actionLabel('SUPERSEDE')).toEqual({ label: 'New price', tone: 'good' });
    expect(actionLabel('ERROR').tone).toBe('bad');
  });
});
