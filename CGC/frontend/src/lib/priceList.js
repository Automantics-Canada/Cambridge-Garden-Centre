/**
 * Agreed rates and price lists on the office screens: the units a rate may be
 * entered in, the price-list template, and the wording of the import preview.
 *
 * Kept out of the components so it can be tested, and so the template the page
 * hands out cannot drift from what the backend reads (a backend test reads
 * TEMPLATE_COLUMNS from this file and compares it with the import's columns).
 */

/** The price-list template's columns, in order. The supplier is picked on the page. */
export const TEMPLATE_COLUMNS = ['product', 'spruce_item_code', 'supplier_item_code', 'unit', 'rate', 'effective_from', 'effective_to', 'notes'];

/**
 * The units a rate can be entered in: the ones the invoice check can compare.
 *
 * There is no plain "ton". It is used for both a metric tonne and a short ton,
 * which differ by about ten percent, so the form makes the person pick one.
 */
export const RATE_UNITS = [
  { value: 'tonne', label: 'Metric tonne (1,000 kg)' },
  { value: 'short ton', label: 'Short ton (2,000 lb)' },
  { value: 'cy', label: 'Cubic yard' },
  { value: 'm3', label: 'Cubic metre' },
  { value: 'each', label: 'Each' },
  { value: 'skid', label: 'Skid' },
  { value: 'load', label: 'Load' },
  { value: 'hour', label: 'Hour' },
  { value: 'sqft', label: 'Square foot' },
  { value: 'kg', label: 'Kilogram' },
  { value: 'lb', label: 'Pound' },
];

export const DEFAULT_RATE_UNIT = 'tonne';

const UNIT_SPELLINGS = {
  tonne: 'tonne', tonnes: 'tonne', mt: 'tonne', t: 'tonne', metricton: 'tonne', metrictons: 'tonne', metrictonne: 'tonne',
  shortton: 'short ton', shorttons: 'short ton', st: 'short ton',
  cy: 'cy', cuyd: 'cy', cubicyard: 'cy', cubicyards: 'cy', yd3: 'cy',
  m3: 'm3', cubicmetre: 'm3', cubicmetres: 'm3', cubicmeter: 'm3', cubicmeters: 'm3',
  each: 'each', ea: 'each', unit: 'each', units: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each',
  skid: 'skid', skids: 'skid', pallet: 'skid', pallets: 'skid',
  load: 'load', loads: 'load', trip: 'load', trips: 'load',
  hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour',
  sqft: 'sqft', sqfeet: 'sqft', sqfoot: 'sqft', sf: 'sqft', ft2: 'sqft', squarefoot: 'sqft', squarefeet: 'sqft',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
};

const AMBIGUOUS_TON = new Set(['ton', 'tons', 'tn', 'tns']);

function unitKey(raw) {
  return String(raw ?? '').toLowerCase().replace(/²/g, '2').replace(/[^a-z0-9]/g, '');
}

/** True for "ton" and its spellings, which could be either ton. */
export function isAmbiguousTon(raw) {
  return AMBIGUOUS_TON.has(unitKey(raw));
}

/**
 * The form's unit value for a stored or typed unit, or '' when the person has
 * to choose (a bare "ton", or a unit the check cannot compare).
 */
export function rateUnitValue(raw) {
  if (!raw || isAmbiguousTon(raw)) return '';
  return UNIT_SPELLINGS[unitKey(raw)] ?? '';
}

export function rateUnitLabel(raw) {
  const value = rateUnitValue(raw);
  return RATE_UNITS.find((unit) => unit.value === value)?.label ?? String(raw ?? '');
}

/** The YYYY-MM-DD part of a date the API sent, or ''. */
export function dayOf(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value == null ? '' : String(value));
  return match ? match[1] : '';
}

/** Where a rate's period stands on `today` (YYYY-MM-DD). */
export function rateStatus(rate, today) {
  const from = dayOf(rate?.effectiveFrom);
  const to = dayOf(rate?.effectiveTo);
  if (from && from > today) return 'future';
  if (to && to < today) return 'ended';
  return 'current';
}

/**
 * The fields an edit actually changes, so the page sends only those.
 *
 * Sending the whole form re-sent the unit and dates on every save, and an
 * empty end date went over as '' even when nobody touched it.
 */
export function changedRateFields(original, form) {
  const before = {
    productName: original?.productName ?? '',
    rate: original?.rate == null ? '' : Number(original.rate),
    unit: original?.unit ?? '',
    effectiveFrom: dayOf(original?.effectiveFrom),
    effectiveTo: dayOf(original?.effectiveTo),
    notes: original?.notes ?? '',
  };
  const after = {
    productName: String(form.productName ?? '').trim(),
    rate: form.rate === '' || form.rate == null ? '' : Number(form.rate),
    unit: form.unit ?? '',
    effectiveFrom: form.effectiveFrom ?? '',
    effectiveTo: form.effectiveTo ?? '',
    notes: String(form.notes ?? '').trim(),
  };
  const changes = {};
  for (const field of Object.keys(after)) {
    if (after[field] !== before[field]) changes[field] = after[field];
  }
  return changes;
}

/** Checks a rate form before it is sent. Returns { field: message }. */
export function validateRateForm(form) {
  const errors = {};
  if (!String(form.productName ?? '').trim()) errors.productName = 'Product is required';
  const rate = Number(form.rate);
  if (form.rate === '' || form.rate == null || !Number.isFinite(rate) || rate < 0) {
    errors.rate = 'Enter a price of 0 or more';
  }
  if (!rateUnitValue(form.unit)) errors.unit = 'Choose a unit';
  if (!form.effectiveFrom) errors.effectiveFrom = 'Start date is required';
  if (form.effectiveTo && form.effectiveFrom && form.effectiveTo < form.effectiveFrom) {
    errors.effectiveTo = 'End date is before the start date';
  }
  return errors;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells) {
  return cells.map(csvCell).join(',');
}

/** The empty template: a header row only, so no example price can be imported by mistake. */
export function buildTemplateCsv() {
  return `${csvLine(TEMPLATE_COLUMNS)}\r\n`;
}

/** A supplier's rates in the template's format, for editing and re-importing. */
export function ratesToCsv(rates) {
  const rows = [...(rates ?? [])]
    .sort((a, b) => a.productName.localeCompare(b.productName) || dayOf(a.effectiveFrom).localeCompare(dayOf(b.effectiveFrom)))
    .map((rate) =>
      csvLine([
        rate.productName,
        rate.spruceItemCode ?? '',
        rate.supplierItemCode ?? '',
        rate.unit,
        Number(rate.rate),
        dayOf(rate.effectiveFrom),
        dayOf(rate.effectiveTo),
        rate.notes ?? '',
      ])
    );
  return [csvLine(TEMPLATE_COLUMNS), ...rows].join('\r\n') + '\r\n';
}

/** A file name safe for a download. */
export function priceListFileName(supplierName, suffix = 'price-list') {
  const slug = String(supplierName ?? 'supplier').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'supplier';
  return `${slug}-${suffix}.csv`;
}

export const ACTION_LABELS = {
  CREATE: { label: 'New', tone: 'good' },
  SUPERSEDE: { label: 'New price', tone: 'good' },
  CORRECT: { label: 'Correction', tone: 'warn' },
  UNCHANGED: { label: 'No change', tone: 'neutral' },
  ERROR: { label: 'Error', tone: 'bad' },
};

export function actionLabel(action) {
  return ACTION_LABELS[action] ?? { label: action, tone: 'neutral' };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** One sentence saying what saving the preview would do, or why it cannot. */
export function summarisePreview(preview) {
  const plan = preview?.plan;
  if (!plan) return '';
  if (plan.fileErrors?.length) return plan.fileErrors.join(' ');
  const { CREATE = 0, SUPERSEDE = 0, CORRECT = 0, UNCHANGED = 0, ERROR = 0 } = plan.counts ?? {};
  if (ERROR > 0) {
    return `${plural(ERROR, 'row has', 'rows have')} an error. Nothing is saved until every row is fixed.`;
  }
  const parts = [];
  if (CREATE) parts.push(plural(CREATE, 'new rate', 'new rates'));
  if (SUPERSEDE) parts.push(plural(SUPERSEDE, 'new price', 'new prices'));
  if (CORRECT) parts.push(plural(CORRECT, 'correction', 'corrections'));
  if (parts.length === 0) return 'Everything in this file is already on record. Nothing to save.';
  const unchanged = UNCHANGED ? ` ${plural(UNCHANGED, 'row is', 'rows are')} already on record.` : '';
  return `Saving adds ${parts.join(', ')}.${unchanged}`;
}

/** Rows for the preview table, errors first so they cannot be missed. */
export function previewRows(preview, { onlyChanges = false } = {}) {
  const rows = preview?.plan?.rows ?? [];
  const order = { ERROR: 0, CORRECT: 1, SUPERSEDE: 2, CREATE: 3, UNCHANGED: 4 };
  return rows
    .filter((row) => !onlyChanges || row.action !== 'UNCHANGED')
    .slice()
    .sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9) || a.rowNumber - b.rowNumber);
}

/** Whether the import accepts this file, judged by its name. */
export function isPriceListFile(file) {
  return /\.(csv|xlsx)$/i.test(file?.name ?? '');
}
