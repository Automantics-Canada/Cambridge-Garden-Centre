/**
 * Units of measure, normalised so two prices are only ever compared when they
 * are prices for the same thing.
 *
 * The invoice check compared a negotiated rate straight against the invoiced
 * unit price without looking at either unit. A rate agreed at $8.10 per tonne
 * measured against $9.10 per short ton is a ten percent error, and it lands on
 * the number the client acts on — in whichever direction happens to hurt.
 *
 * The rule here is deliberately conservative: normalise, compare canonical
 * codes, and refuse to compare when they differ or when either side is not
 * recognised. Refusing shows up as RATE_UNKNOWN / UNIT_MISMATCH on the
 * verification desk, which a person can resolve. Guessing does not.
 */

export type CanonicalUnit =
  | 'TONNE'
  | 'SHORT_TON'
  | 'KILOGRAM'
  | 'POUND'
  | 'CUBIC_YARD'
  | 'CUBIC_METRE'
  | 'SKID'
  | 'EACH'
  | 'LOAD'
  | 'HOUR';

/**
 * Alias table, lower-cased and stripped of punctuation before lookup.
 *
 * `ton` and `tonne` are held apart on purpose. They differ by about ten
 * percent, both appear on Ontario aggregate paperwork, and "ton" is used
 * loosely for both — which is exactly why the system must not decide which one
 * a supplier meant. If the client confirms a supplier always means one of them,
 * fix it in that supplier's rate table rather than by merging these entries.
 */
const UNIT_ALIASES: Record<string, CanonicalUnit> = {
  // metric tonne, 1000 kg
  tonne: 'TONNE',
  tonnes: 'TONNE',
  mt: 'TONNE',
  't': 'TONNE',
  metricton: 'TONNE',
  metrictons: 'TONNE',
  metrictonne: 'TONNE',

  // short ton, 2000 lb
  ton: 'SHORT_TON',
  tons: 'SHORT_TON',
  shortton: 'SHORT_TON',
  shorttons: 'SHORT_TON',
  st: 'SHORT_TON',

  kg: 'KILOGRAM',
  kgs: 'KILOGRAM',
  kilo: 'KILOGRAM',
  kilos: 'KILOGRAM',
  kilogram: 'KILOGRAM',
  kilograms: 'KILOGRAM',

  lb: 'POUND',
  lbs: 'POUND',
  pound: 'POUND',
  pounds: 'POUND',

  cy: 'CUBIC_YARD',
  cuyd: 'CUBIC_YARD',
  cubicyard: 'CUBIC_YARD',
  cubicyards: 'CUBIC_YARD',
  yd3: 'CUBIC_YARD',

  m3: 'CUBIC_METRE',
  cubicmetre: 'CUBIC_METRE',
  cubicmetres: 'CUBIC_METRE',
  cubicmeter: 'CUBIC_METRE',
  cubicmeters: 'CUBIC_METRE',

  skid: 'SKID',
  skids: 'SKID',
  pallet: 'SKID',
  pallets: 'SKID',

  ea: 'EACH',
  each: 'EACH',
  unit: 'EACH',
  units: 'EACH',
  pc: 'EACH',
  pcs: 'EACH',
  piece: 'EACH',
  pieces: 'EACH',

  load: 'LOAD',
  loads: 'LOAD',
  trip: 'LOAD',
  trips: 'LOAD',

  hr: 'HOUR',
  hrs: 'HOUR',
  hour: 'HOUR',
  hours: 'HOUR',
};

/**
 * Canonical code for a written unit, or null when it is not recognised.
 *
 * Null is a real answer and callers must handle it as "do not compare", never
 * as "assume they match".
 */
export function normaliseUnit(raw: string | null | undefined): CanonicalUnit | null {
  if (!raw) return null;

  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (!key) return null;
  return UNIT_ALIASES[key] ?? null;
}

export type UnitComparison =
  | { comparable: true; unit: CanonicalUnit }
  | { comparable: false; reason: 'UNRECOGNISED'; invoiceUnit: string | null; rateUnit: string | null }
  | { comparable: false; reason: 'DIFFERENT'; invoiceUnit: CanonicalUnit; rateUnit: CanonicalUnit };

/**
 * Whether two prices expressed in these units may be compared directly.
 *
 * No conversion is attempted. Converting would mean inventing a density for
 * tonnes-to-cubic-yards, which varies by material and is not the system's to
 * assume.
 */
export function compareUnits(
  invoiceUnitRaw: string | null | undefined,
  rateUnitRaw: string | null | undefined
): UnitComparison {
  const invoiceUnit = normaliseUnit(invoiceUnitRaw);
  const rateUnit = normaliseUnit(rateUnitRaw);

  if (!invoiceUnit || !rateUnit) {
    return {
      comparable: false,
      reason: 'UNRECOGNISED',
      invoiceUnit: invoiceUnitRaw?.trim() || null,
      rateUnit: rateUnitRaw?.trim() || null,
    };
  }

  if (invoiceUnit !== rateUnit) {
    return { comparable: false, reason: 'DIFFERENT', invoiceUnit, rateUnit };
  }

  return { comparable: true, unit: invoiceUnit };
}
