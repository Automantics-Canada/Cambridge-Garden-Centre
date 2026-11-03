/**
 * The rules for a dispatch load and its haul rate, apart from the database so
 * they can be tested on their own.
 *
 * The client (Oct 2026, Q14): the dispatcher sets a rate on every load, and
 * the trucking invoice is matched against it when it comes in. These rules
 * keep what is recorded usable for that: a rate is never negative and always
 * says what it is per, and a load an invoice has already paid keeps its
 * figures.
 */

export const HAUL_RATE_UNITS = ['LOAD', 'HOUR', 'TONNE'] as const;
export type HaulRateUnitValue = (typeof HAUL_RATE_UNITS)[number];

/** What a request may set on a load. A key left out is left alone. */
export interface LoadInput {
  carrierSupplierId?: string | null;
  driverId?: string | null;
  /** A decimal string with at most four places, "95.5". */
  rate?: string | null;
  rateUnit?: HaulRateUnitValue | null;
  quantity?: string | null;
  sourceSupplierId?: string | null;
  tripRef?: string | null;
  ticketNumber?: string | null;
  notes?: string | null;
}

export type LoadField = keyof LoadInput;

export const LOAD_FIELDS: LoadField[] = [
  'carrierSupplierId', 'driverId', 'rate', 'rateUnit', 'quantity',
  'sourceSupplierId', 'tripRef', 'ticketNumber', 'notes',
];

/**
 * Once an invoice line has paid a load, only its note may change. Re-pricing,
 * re-assigning or regrouping a paid haul would leave the invoice checked
 * against figures that no longer exist.
 */
export const EDITABLE_WHEN_CLAIMED: LoadField[] = ['notes'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Up to 99,999,999.9999: what Decimal(12, 4) holds. */
const DECIMAL = /^\d{1,8}(?:\.\d{1,4})?$/;

const TEXT_LIMITS = { tripRef: 40, ticketNumber: 40, notes: 500 } as const;

export class LoadInputError extends Error {
  readonly status = 400;
}

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function idOrNull(value: unknown, what: string): string | null {
  if (value === null || value === '') return null;
  if (!isUuid(value)) throw new LoadInputError(`${what} is not one the app knows.`);
  return value;
}

/** A decimal as text, so nothing is lost to floating point on its way in. */
function decimalOrNull(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
  if (text === null) throw new LoadInputError(`${what} must be a number.`);
  if (text === '') return null;
  if (!DECIMAL.test(text)) {
    throw new LoadInputError(`${what} must be a number of 0 or more, with at most four decimal places.`);
  }
  return text;
}

function textOrNull(value: unknown, key: keyof typeof TEXT_LIMITS, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new LoadInputError(`${what} must be text.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  if (text.length > TEXT_LIMITS[key]) throw new LoadInputError(`${what} is longer than ${TEXT_LIMITS[key]} characters.`);
  return text;
}

/**
 * A trip reference as stored: spaces tidied and upper case, so "t-12" and
 * "T-12 " are the same trip and the index finds them.
 */
export const normaliseTripRef = (value: string) => value.replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * The load fields a request body sets, checked. Unknown keys are ignored; a
 * key that is present but empty clears that field.
 */
export function parseLoadInput(body: unknown): LoadInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new LoadInputError('Send the load as an object.');
  }
  const raw = body as Record<string, unknown>;
  const has = (key: LoadField) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined;
  const input: LoadInput = {};

  if (has('carrierSupplierId')) input.carrierSupplierId = idOrNull(raw.carrierSupplierId, 'That carrier');
  if (has('driverId')) input.driverId = idOrNull(raw.driverId, 'That driver');
  if (has('sourceSupplierId')) input.sourceSupplierId = idOrNull(raw.sourceSupplierId, 'That pit or supplier');
  if (has('rate')) {
    const rate = decimalOrNull(raw.rate, 'The rate');
    input.rate = rate;
  }
  if (has('rateUnit')) {
    const unit = raw.rateUnit === '' || raw.rateUnit === null ? null : String(raw.rateUnit).toUpperCase();
    if (unit !== null && !(HAUL_RATE_UNITS as readonly string[]).includes(unit)) {
      throw new LoadInputError('The rate is per load, per hour or per tonne.');
    }
    input.rateUnit = unit as HaulRateUnitValue | null;
  }
  if (has('quantity')) {
    const quantity = decimalOrNull(raw.quantity, 'The expected quantity');
    if (quantity !== null && Number(quantity) === 0) throw new LoadInputError('The expected quantity must be more than 0.');
    input.quantity = quantity;
  }
  if (has('tripRef')) {
    const trip = textOrNull(raw.tripRef, 'tripRef', 'The trip reference');
    input.tripRef = trip === null ? null : normaliseTripRef(trip);
  }
  if (has('ticketNumber')) input.ticketNumber = textOrNull(raw.ticketNumber, 'ticketNumber', 'The ticket number');
  if (has('notes')) input.notes = textOrNull(raw.notes, 'notes', 'The note');
  return input;
}

/** A load's fields as the rules compare them: decimals as fixed text. */
export interface LoadState {
  carrierSupplierId: string | null;
  driverId: string | null;
  rate: string | null;
  rateUnit: HaulRateUnitValue | null;
  quantity: string | null;
  sourceSupplierId: string | null;
  tripRef: string | null;
  ticketNumber: string | null;
  notes: string | null;
}

/** Equal decimals compare equal whatever their trailing zeros: "95" and "95.0000". */
const sameValue = (field: LoadField, a: string | null, b: string | null) =>
  (field === 'rate' || field === 'quantity') && a !== null && b !== null ? Number(a) === Number(b) : a === b;

/** The load after `input` is applied, and the rule every saved load keeps. */
export function applyLoadInput(before: LoadState, input: LoadInput): LoadState {
  const after: LoadState = { ...before };
  for (const field of LOAD_FIELDS) {
    if (input[field] !== undefined) (after as unknown as Record<string, unknown>)[field] = input[field];
  }
  if (after.rate !== null && after.rateUnit === null) {
    throw new LoadInputError('Say whether the rate is per load, per hour or per tonne.');
  }
  return after;
}

export interface LoadChange {
  field: LoadField;
  from: string | null;
  to: string | null;
}

/** What `input` changes on a load, field by field, for the audit row. */
export function loadChanges(before: LoadState, after: LoadState): LoadChange[] {
  return LOAD_FIELDS
    .filter(field => !sameValue(field, before[field], after[field]))
    .map(field => ({ field, from: before[field], to: after[field] }));
}

/** The changes a paid load refuses: everything but its note. */
export function lockedChanges(changes: LoadChange[]): LoadField[] {
  return changes.map(change => change.field).filter(field => !EDITABLE_WHEN_CLAIMED.includes(field));
}

/** A rate or unit change is audited as LOAD_RATE_SET; anything else as LOAD_UPDATED. */
export const changesRate = (changes: LoadChange[]) =>
  changes.some(change => change.field === 'rate' || change.field === 'rateUnit');

/**
 * What a trucking invoice line is checked against on a load (haulMatch.ts):
 * who hauled it, at what rate and per what, how much, which trip, and the
 * ticket that names it. A pit or a note changes no verdict.
 */
export const HAUL_CHECK_FIELDS: readonly LoadField[] = [
  'carrierSupplierId', 'rate', 'rateUnit', 'quantity', 'tripRef', 'ticketNumber',
];

/**
 * The trucking companies whose open invoice lines may read differently after
 * a load changed: the carrier before and the carrier after, when anything a
 * haul line is checked against changed. Empty for CGC's own trucks and for a
 * change to the pit or the note.
 *
 * Without this, a trucking invoice that arrived before dispatch filled in the
 * rate kept saying "No haul rate set" until somebody re-ran it by hand.
 *
 * @param before The load before the change; null for a new load.
 * @param after The load after it; null for a removed load.
 */
export function carriersToRecheck(
  before: Pick<LoadState, 'carrierSupplierId'> | null,
  after: Pick<LoadState, 'carrierSupplierId'> | null,
  changes: LoadChange[]
): string[] {
  if (!changes.some(change => HAUL_CHECK_FIELDS.includes(change.field))) return [];
  return [...new Set([before?.carrierSupplierId, after?.carrierSupplierId].filter((id): id is string => Boolean(id)))];
}

/** One load as `billableHauls` reads it. */
export interface HaulLoad {
  id: string;
  documentId: string;
  carrierSupplierId: string | null;
  tripRef: string | null;
  rate: string | null;
  rateUnit: HaulRateUnitValue | null;
  quantity: string | null;
  claimedByLineItemId: string | null;
}

/**
 * One thing a trucking company bills CGC for: a single load, a brokered trip
 * that served several orders, or one load of such a trip billed on its own
 * line (`tripLoadHaul`).
 */
export interface BillableHaul {
  carrierSupplierId: string;
  /** The trip the haul is, or belongs to; null for a load on no trip. */
  tripRef: string | null;
  loadIds: string[];
  documentIds: string[];
  /** The agreed rate; null when none is set yet, or the trip's loads disagree. */
  rate: string | null;
  rateUnit: HaulRateUnitValue | null;
  /** The trip's loads carry different rates or units: dispatch must settle it. */
  rateConflict: boolean;
  /**
   * The expected quantity in `rateUnit`: a single load's own; for a trip by
   * the load the number of its loads, and by the tonne the tonnes of all its
   * loads. Null when unknown, and for a trip by the hour (not yet known how
   * the client records the hours of a shared trip).
   */
  quantity: string | null;
  /** Every load of it is already paid by an invoice line. */
  claimed: boolean;
}

const decimalSum = (values: string[]) =>
  (Math.round(values.reduce((sum, value) => sum + Number(value) * 10_000, 0)) / 10_000).toString();

/** A load's rate and unit as one comparable value. */
const rateKey = (load: HaulLoad) => (load.rate === null ? 'none' : `${Number(load.rate)}|${load.rateUnit}`);

/**
 * What a carrier can bill for, out of its loads: each load on its own, except
 * the loads of one trip, which are also one haul together. CGC's own trucks
 * bill nobody and are left out.
 *
 * The rate on a load is what that load costs (the client's A14: "a spot for a
 * rate on every single dispatch load"), and a trip is the loads one brokered
 * truck collected together (A4). So a carrier may bill a trip in two ways,
 * and both cost the same: one line for the whole trip, its loads times the
 * rate, or one line per load, each against its own load (`tripLoadHaul`).
 * The matcher decides which a line is; either way a load is paid once.
 *
 * This is the contract the trucking-invoice matcher reads loads through.
 */
export function billableHauls(loads: HaulLoad[]): BillableHaul[] {
  const groups = new Map<string, HaulLoad[]>();
  for (const load of loads) {
    if (!load.carrierSupplierId) continue;
    const key = load.tripRef
      ? `trip|${load.carrierSupplierId}|${normaliseTripRef(load.tripRef)}`
      : `load|${load.id}`;
    groups.set(key, [...(groups.get(key) ?? []), load]);
  }

  return [...groups.values()].map(group => {
    const first = group[0]!;
    const trip = first.tripRef ? normaliseTripRef(first.tripRef) : null;
    const rateConflict = new Set(group.map(rateKey)).size > 1;
    const priced = !rateConflict && first.rate !== null;
    const unit = priced ? first.rateUnit : null;

    let quantity: string | null = null;
    if (!trip) quantity = first.quantity;
    // Each load counts as the loads dispatch expected on it, one unless it says otherwise.
    else if (unit === 'LOAD') quantity = decimalSum(group.map(load => load.quantity ?? '1'));
    else if (unit === 'TONNE' && group.every(load => load.quantity !== null)) {
      quantity = decimalSum(group.map(load => load.quantity!));
    }

    return {
      carrierSupplierId: first.carrierSupplierId!,
      tripRef: trip,
      loadIds: group.map(load => load.id),
      documentIds: [...new Set(group.map(load => load.documentId))],
      rate: priced ? first.rate : null,
      rateUnit: unit,
      rateConflict,
      quantity,
      claimed: group.every(load => load.claimedByLineItemId !== null),
    };
  });
}

/**
 * One load of a brokered trip, billed on a line of its own: checked against
 * that load's own rate and quantity, and paying only that load. The trip is
 * kept as `tripRef` so the desk can say which trip it belongs to.
 *
 * Only for a load with a carrier: CGC's own trucks bill nobody.
 */
export function tripLoadHaul(load: HaulLoad & { carrierSupplierId: string }): BillableHaul {
  return {
    carrierSupplierId: load.carrierSupplierId,
    tripRef: load.tripRef ? normaliseTripRef(load.tripRef) : null,
    loadIds: [load.id],
    documentIds: [load.documentId],
    rate: load.rate,
    rateUnit: load.rate === null ? null : load.rateUnit,
    rateConflict: false,
    quantity: load.quantity,
    claimed: load.claimedByLineItemId !== null,
  };
}
