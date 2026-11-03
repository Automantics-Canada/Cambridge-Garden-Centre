/**
 * Dispatch loads and their haul rates on the office board (client, Oct 2026,
 * Q14): "a spot for a rate on every single dispatch load".
 *
 * The board only ever gets these from the office board's own payload; a
 * driver's phone never does. Kept out of the components so the badge rule and
 * the form's checks can be tested.
 */

/** How a haul rate is charged. The server knows exactly these three. */
export const HAUL_RATE_UNITS = [
  { value: 'LOAD', label: 'per load', short: 'load' },
  { value: 'HOUR', label: 'per hour', short: 'hr' },
  { value: 'TONNE', label: 'per tonne', short: 't' },
];

/** The carrier select's value for CGC's own trucks (no carrier). */
export const CGC_FLEET = '';

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/** "$95.00 / load"; empty when there is no rate. */
export function formatHaulRate(rate, unit) {
  if (rate === null || rate === undefined || rate === '' || !Number.isFinite(Number(rate))) return '';
  const short = HAUL_RATE_UNITS.find((option) => option.value === unit)?.short;
  return short ? `${money.format(Number(rate))} / ${short}` : money.format(Number(rate));
}

const isIndependent = (driver) => driver?.type === 'INDEPENDENT';
const hasRate = (load) => load?.rate !== null && load?.rate !== undefined;

/**
 * Whether the order needs a haul rate from dispatch, for the "No haul rate"
 * badge: its stop is on an independent (brokered) driver and none of its loads
 * has a rate yet, or one of its loads names a carrier or an independent driver
 * and has no rate. CGC's own trucks with no rate are fine: nobody bills CGC
 * for them.
 *
 * @param order a board order, with `haulLoads` from the office board
 * @param stopDriver the driver whose run the order is on, if any
 */
export function needsHaulRate(order, stopDriver = null) {
  if (!order?.wholeOrder) return false;
  const loads = Array.isArray(order.haulLoads) ? order.haulLoads : [];
  if (isIndependent(stopDriver) && !loads.some(hasRate)) return true;
  return loads.some((load) => !hasRate(load) && (Boolean(load.carrierSupplierId) || load.driverType === 'INDEPENDENT'));
}

/** "2 loads · $95.00 / load" for the board row; empty when the order has none. */
export function loadSummary(order) {
  const loads = Array.isArray(order?.haulLoads) ? order.haulLoads : [];
  if (loads.length === 0) return '';
  const count = `${loads.length} load${loads.length === 1 ? '' : 's'}`;
  const rates = [...new Set(loads.filter(hasRate).map((load) => formatHaulRate(load.rate, load.rateUnit)))];
  if (rates.length === 0) return count;
  return `${count} · ${rates.length === 1 ? rates[0] : 'mixed rates'}`;
}

const UNIT_NOUNS = { LOAD: 'loads', HOUR: 'hours', TONNE: 'tonnes' };

/** "Expected 3 hours"; empty when no quantity is set. */
export function expectedText(load) {
  if (load?.quantity === null || load?.quantity === undefined || load.quantity === '') return '';
  const noun = UNIT_NOUNS[load.rateUnit];
  return noun ? `Expected ${load.quantity} ${noun}` : `Expected ${load.quantity}`;
}

/** Who hauls a load, as the list shows it. */
export function carrierLabel(load) {
  if (load?.carrierName) return load.carrierName;
  if (load?.driverType === 'INDEPENDENT' && load.driverName) return load.driverName;
  return 'CGC fleet';
}

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The trucking company an independent driver works for, when exactly one
 * carrier has that company name. Offered in the form, never saved on its own.
 */
export function suggestedCarrier(driver, carriers) {
  if (!isIndependent(driver) || !tidy(driver.companyName)) return null;
  const matches = (carriers ?? []).filter((carrier) => tidy(carrier.name) === tidy(driver.companyName));
  return matches.length === 1 ? matches[0] : null;
}

const text = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * The form for a new load. A brokered driver's company and per-trip rate are
 * filled in for the dispatcher to check; the order's pit is the server's
 * default and left blank here.
 */
export function newLoadForm(stopDriver = null, carriers = []) {
  const carrier = suggestedCarrier(stopDriver, carriers);
  const tripRate = isIndependent(stopDriver) && stopDriver.ratePerTrip !== null && stopDriver.ratePerTrip !== undefined
    ? Number(stopDriver.ratePerTrip)
    : null;
  return {
    carrierSupplierId: carrier?.id ?? CGC_FLEET,
    rate: tripRate !== null && Number.isFinite(tripRate) && tripRate > 0 ? String(tripRate) : '',
    rateUnit: 'LOAD',
    quantity: '',
    sourceSupplierId: '',
    tripRef: '',
    ticketNumber: '',
    notes: '',
  };
}

/** The form for an existing load. */
export function loadForm(load) {
  return {
    carrierSupplierId: load?.carrierSupplierId ?? CGC_FLEET,
    rate: text(load?.rate),
    rateUnit: load?.rateUnit ?? 'LOAD',
    quantity: text(load?.quantity),
    sourceSupplierId: load?.sourceSupplierId ?? '',
    tripRef: load?.tripRef ?? '',
    ticketNumber: load?.ticketNumber ?? '',
    notes: load?.notes ?? '',
  };
}

const DECIMAL = /^\d{1,8}(?:\.\d{1,4})?$/;

/** "$1,200.50" typed as a rate is 1200.50. */
const cleanNumber = (value) => String(value ?? '').replace(/[$,\s]/g, '');

/**
 * The form checked, and the request body to send. A unit is sent only with a
 * rate, so a load with no rate yet is saved without one.
 *
 * @returns {{ errors: Record<string, string>, body: object | null }}
 */
export function validateLoadForm(form) {
  const errors = {};
  const rate = cleanNumber(form.rate);
  const quantity = cleanNumber(form.quantity);

  if (rate !== '' && !DECIMAL.test(rate)) errors.rate = 'A number of 0 or more, like 95 or 95.50.';
  if (rate !== '' && !HAUL_RATE_UNITS.some((option) => option.value === form.rateUnit)) {
    errors.rateUnit = 'Per load, per hour or per tonne.';
  }
  if (quantity !== '' && (!DECIMAL.test(quantity) || Number(quantity) === 0)) {
    errors.quantity = 'A number more than 0.';
  }
  if (String(form.tripRef ?? '').trim().length > 40) errors.tripRef = 'At most 40 characters.';
  if (String(form.ticketNumber ?? '').trim().length > 40) errors.ticketNumber = 'At most 40 characters.';
  if (String(form.notes ?? '').trim().length > 500) errors.notes = 'At most 500 characters.';
  if (Object.keys(errors).length > 0) return { errors, body: null };

  return {
    errors,
    body: {
      carrierSupplierId: form.carrierSupplierId || null,
      rate: rate === '' ? null : rate,
      rateUnit: rate === '' ? null : form.rateUnit,
      quantity: quantity === '' ? null : quantity,
      sourceSupplierId: form.sourceSupplierId || null,
      tripRef: String(form.tripRef ?? '').trim() || null,
      ticketNumber: String(form.ticketNumber ?? '').trim() || null,
      notes: String(form.notes ?? '').trim() || null,
    },
  };
}

/**
 * Only what changed on an existing load, so saving the note of a paid load
 * does not send figures the server would refuse to change.
 */
export function changedLoadFields(load, body) {
  const before = validateLoadForm(loadForm(load)).body ?? {};
  const same = (key) => {
    if (key === 'rate' || key === 'quantity') {
      return before[key] === body[key] || (before[key] !== null && body[key] !== null && Number(before[key]) === Number(body[key]));
    }
    // A trip reference is stored in capitals.
    if (key === 'tripRef') return (before[key] ?? '').toUpperCase() === (body[key] ?? '').toUpperCase();
    return before[key] === body[key];
  };
  return Object.fromEntries(Object.entries(body).filter(([key]) => !same(key)));
}

/** What the trip line under a load says: "Trip T-21: 3 loads, 2608-1, 2608-2". */
export function tripText(load) {
  if (!load?.tripRef) return '';
  const trip = load.trip;
  if (!trip) return `Trip ${load.tripRef}`;
  const loads = `${trip.loads} load${trip.loads === 1 ? '' : 's'}`;
  return `Trip ${load.tripRef}: ${loads}${trip.orders?.length ? `, ${trip.orders.join(', ')}` : ''}`;
}

/**
 * The suppliers a load can be "Loaded at": a pit or yard, never a trucking
 * company (client, Q5: the hauler is the load's carrier, not where the
 * material comes from). A load already saved with one still names it: the
 * form adds the chosen supplier when it is not in this list.
 */
export function loadedAtSuppliers(suppliers) {
  return (suppliers ?? []).filter((supplier) => supplier?.type !== 'TRUCKING_COMPANY');
}
