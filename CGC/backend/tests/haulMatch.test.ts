import './setupEnv.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  haulCandidates,
  matchHaulLine,
  type CandidateLoad,
  type HaulLineSubject,
} from '../src/modules/matching/haulMatch.js';
import {
  DEFAULT_HAUL_TOLERANCES,
  resolveHaulTolerances,
  type HaulTolerances,
} from '../src/modules/matching/tolerances.js';

/**
 * A trucking company's invoice line against the loads dispatch recorded
 * (client, Oct 2026, Q14: "the dispatcher sets the rate for each load
 * dispatched and it is matched up when the invoice comes in").
 *
 * Every case is one CGC could pay a hauler wrongly over: the wrong load, a
 * rate above what dispatch agreed, a trip's load paid twice (once on the
 * trip's line, once on its own), a load paid twice, a guess passed off as a
 * match, or a fair line refused. Every name and number is invented.
 */

const CARRIER = 'carrier-example-haulage';
const OTHER_CARRIER = 'carrier-other';
const DAY = new Date('2026-10-28T00:00:00.000Z');
const tolerances: HaulTolerances = { ...DEFAULT_HAUL_TOLERANCES };

const daysFrom = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

let nextId = 1;
function load(overrides: Partial<CandidateLoad> = {}): CandidateLoad {
  const id = `load-${nextId++}`;
  return {
    id,
    documentId: `doc-${id}`,
    sequence: 1,
    carrierSupplierId: CARRIER,
    tripRef: null,
    rate: '185',
    rateUnit: 'LOAD',
    quantity: null,
    claimedByLineItemId: null,
    documentNumber: `9100${nextId}`,
    haulDate: DAY,
    ticketNumber: null,
    poNumbers: [],
    orderTicketNumbers: [],
    orderLineId: `order-line-${id}`,
    claim: null,
    ...overrides,
  };
}

function line(overrides: Partial<HaulLineSubject> = {}): HaulLineSubject {
  return {
    id: 'line-1',
    poNumber: null,
    ticketNumber: null,
    serviceDate: DAY,
    quantity: 1,
    unit: 'load',
    unitRate: 185,
    supplierId: CARRIER,
    invoiceDate: daysFrom(DAY, 3),
    ...overrides,
  };
}

const check = (decision: ReturnType<typeof matchHaulLine>, name: string) =>
  decision.checks.find((entry) => entry.name === name);

describe('finding the load', () => {
  test('a ticket number picks one of two same-day loads', () => {
    const a = load({ ticketNumber: 'T-40017' });
    const b = load({ ticketNumber: 'T-40018' });
    const decision = matchHaulLine(line({ ticketNumber: '#t40018' }), [a, b], { tolerances });
    assert.equal(decision.status, 'MATCHED');
    assert.deepEqual(decision.loadIds, [b.id]);
    assert.equal(decision.orderId, b.orderLineId);
    assert.match(check(decision, 'haulLoad')!.detail, /found by ticket/);
  });

  test('a ticket the driver photographed on the order identifies its load', () => {
    const a = load({ orderTicketNumbers: ['55120'] });
    const b = load();
    const decision = matchHaulLine(line({ ticketNumber: '55120' }), [a, b], { tolerances });
    assert.deepEqual(decision.loadIds, [a.id]);
    assert.equal(decision.status, 'MATCHED');
  });

  test('the PO, or the CGC order number written in its place, identifies the load', () => {
    const a = load({ poNumbers: ['2608-355356'] });
    const b = load({ documentNumber: '910777' });
    const byPo = matchHaulLine(line({ poNumber: '355356' }), [a, b], { tolerances });
    assert.deepEqual(byPo.loadIds, [a.id]);
    assert.equal(byPo.status, 'MATCHED');
    const byOrder = matchHaulLine(line({ poNumber: '910777' }), [a, b], { tolerances });
    assert.deepEqual(byOrder.loadIds, [b.id]);
  });

  test('carrier and date alone find the load but never pass it', () => {
    const only = load();
    const decision = matchHaulLine(line(), [only], { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    assert.deepEqual(decision.loadIds, [only.id]);
    assert.equal(check(decision, 'haulLoad')!.passed, false);
    assert.match(check(decision, 'haulLoad')!.detail, /carrier and date only/);
  });

  test('carrier, date and quantity tell two loads that day apart, still for a person to confirm', () => {
    const three = load({ rateUnit: 'HOUR', rate: '120', quantity: '3' });
    const five = load({ rateUnit: 'HOUR', rate: '120', quantity: '5' });
    const decision = matchHaulLine(line({ unit: 'hr', unitRate: 120, quantity: 5 }), [three, five], { tolerances });
    assert.deepEqual(decision.loadIds, [five.id]);
    assert.equal(decision.status, 'PARTIAL');
  });

  test('two loads nothing tells apart are a CONFLICT naming both orders', () => {
    const a = load();
    const b = load();
    const decision = matchHaulLine(line(), [a, b], { tolerances });
    assert.equal(decision.status, 'CONFLICT');
    assert.deepEqual(decision.loadIds, []);
    assert.deepEqual(new Set(decision.candidateOrderIds), new Set([a.orderLineId, b.orderLineId]));
  });

  test('with a haul day on the line, the date fallback only looks at that day', () => {
    const earlier = load({ haulDate: daysFrom(DAY, -3) });
    const decision = matchHaulLine(line(), [earlier], { tolerances });
    assert.equal(decision.status, 'UNMATCHED');
    assert.equal(check(decision, 'haulLoad')!.code, 'NO_LOAD_FOUND');
  });

  test('no load on the board is NO_LOAD_FOUND, for a person', () => {
    const decision = matchHaulLine(line({ ticketNumber: 'T-101' }), [], { tolerances });
    assert.equal(decision.status, 'UNMATCHED');
    assert.equal(decision.orderId, null);
    assert.equal(check(decision, 'haulLoad')!.code, 'NO_LOAD_FOUND');
    assert.equal(decision.totals?.agreedRate, null);
  });

  test("CGC's own trucks are never candidates", () => {
    const fleet = load({ carrierSupplierId: null, ticketNumber: 'T-40017' });
    const decision = matchHaulLine(line({ ticketNumber: 'T-40017' }), [fleet], { tolerances });
    assert.equal(decision.status, 'UNMATCHED');
    assert.deepEqual(haulCandidates([fleet], CARRIER, DAY, 7), []);
  });

  test("another carrier's load is never a candidate", () => {
    const theirs = load({ carrierSupplierId: OTHER_CARRIER, ticketNumber: 'T-40017' });
    const decision = matchHaulLine(line({ ticketNumber: 'T-40017' }), [theirs], { tolerances });
    assert.equal(decision.status, 'UNMATCHED');
  });

  test('a load outside the date window is not found, even by its ticket', () => {
    const old = load({ ticketNumber: 'T-40017', haulDate: daysFrom(DAY, -8) });
    const decision = matchHaulLine(line({ ticketNumber: 'T-40017' }), [old], { tolerances });
    assert.equal(decision.status, 'UNMATCHED');
    const inside = load({ ticketNumber: 'T-40018', haulDate: daysFrom(DAY, -7) });
    assert.equal(matchHaulLine(line({ ticketNumber: 'T-40018' }), [inside], { tolerances }).status, 'MATCHED');
  });

  test("a PO that is not on the ticket's load is held for a person", () => {
    const a = load({ ticketNumber: 'T-40017', poNumbers: ['111111'] });
    const decision = matchHaulLine(line({ ticketNumber: 'T-40017', poNumber: '222222' }), [a], { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    assert.match(check(decision, 'haulLoad')!.detail, /222222/);
  });
});

describe('a brokered trip (A4: one truck, several POs)', () => {
  const trip = () => [
    load({ tripRef: 'T-12', poNumbers: ['2608-100001'], rate: '150', rateUnit: 'LOAD' }),
    load({ tripRef: 'T-12', poNumbers: ['2608-100002'], rate: '150', rateUnit: 'LOAD' }),
    load({ tripRef: 'T-12', poNumbers: ['2608-100003'], rate: '150', rateUnit: 'LOAD' }),
  ];

  test('one invoice line for the whole trip bills every load of it at the rate', () => {
    const loads = trip();
    const decision = matchHaulLine(line({ poNumber: '100002', unitRate: 150, quantity: 3 }), loads, { tolerances });
    assert.equal(decision.status, 'MATCHED', decision.reason);
    assert.deepEqual(decision.loadIds, loads.map((entry) => entry.id));
    assert.equal(decision.totals?.agreedRate, 150);
    assert.equal(check(decision, 'haulQuantity')!.expected, 3);
  });

  test('a whole-trip line billing fewer loads than the trip had is for a person', () => {
    // Nothing on the line names one load, so it is read as the trip: one
    // load billed for three is not passed (the others may come on their own lines).
    const decision = matchHaulLine(line({ poNumber: '100002', unitRate: 150, quantity: 1 }), trip(), { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    const quantity = check(decision, 'haulQuantity')!;
    assert.equal(quantity.passed, false);
    assert.equal(quantity.expected, 3);
    assert.match(quantity.detail, /trip T-12 has 3 loads/);
  });

  test('a trip whose loads carry different rates is for dispatch to settle', () => {
    const loads = trip();
    loads[1]!.rate = '160';
    const decision = matchHaulLine(line({ poNumber: '100001', unitRate: 150 }), loads, { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'haulRate')!.code, 'TRIP_RATES_DIFFER');
  });

  test('a trip reference reused on another day is another trip, and is shown to a person', () => {
    const today = load({ tripRef: 'T-12', poNumbers: ['2608-100001'], ticketNumber: 'T-500' });
    const later = load({ tripRef: 'T-12', poNumbers: ['2608-100009'], haulDate: daysFrom(DAY, 2) });
    const decision = matchHaulLine(line({ ticketNumber: 'T-500' }), [today, later], { tolerances });
    assert.deepEqual(decision.loadIds, [today.id], 'the later day must not be paid with this line');
    // Reused, or one trip whose orders carry different dates: not for the
    // matcher to decide, so it is never passed on its own.
    assert.equal(decision.status, 'PARTIAL');
    const trip = check(decision, 'haulTrip')!;
    assert.equal(trip.code, 'TRIP_SPANS_DAYS');
    assert.match(trip.detail, /on 2026-10-30/);
  });

  test('the second half of a trip split across days is not passed as a fresh haul', () => {
    // One brokered truck, two orders; the carried-over order keeps an older
    // Spruce date, so the halves fall on different days. The first half is
    // already paid; a second bill naming the other order must not sail through.
    const first = load({
      tripRef: 'T-12', poNumbers: ['2608-100001'], haulDate: daysFrom(DAY, -1),
      claimedByLineItemId: 'line-paid', claim: { invoiceNumber: 'HX-1', lineNumber: 1 },
    });
    const second = load({ tripRef: 'T-12', poNumbers: ['2608-100002'] });
    const decision = matchHaulLine(line({ poNumber: '100002' }), [first, second], { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    assert.deepEqual(decision.loadIds, [second.id]);
    assert.match(check(decision, 'haulTrip')!.detail, /paid on invoice HX-1 line 1/);
  });

  test('a trip reference used again outside the window is not mentioned', () => {
    const today = load({ tripRef: 'T-12', poNumbers: ['2608-100001'] });
    const nextMonth = load({ tripRef: 'T-12', poNumbers: ['2608-100009'], haulDate: daysFrom(DAY, 30) });
    const decision = matchHaulLine(line({ poNumber: '100001' }), [today, nextMonth], { tolerances });
    assert.equal(decision.status, 'MATCHED', decision.reason);
    assert.equal(check(decision, 'haulTrip'), undefined);
  });

  test('a trip reference reused the next week does not match at all', () => {
    const nextWeek = load({ tripRef: 'T-12', poNumbers: ['2608-100001'], haulDate: daysFrom(DAY, 9) });
    const decision = matchHaulLine(line({ poNumber: '100001' }), [nextWeek], { tolerances });
    assert.equal(decision.status, 'UNMATCHED');
  });
});

describe('a brokered trip billed load by load (Q14: a rate on every load)', () => {
  const trip = (unit: 'LOAD' | 'TONNE' | 'HOUR' = 'LOAD') => [
    load({ tripRef: 'T-30', ticketNumber: 'DX-1101', poNumbers: ['2608-200001'], rate: '140', rateUnit: unit, quantity: unit === 'LOAD' ? '1' : '14' }),
    load({ tripRef: 'T-30', ticketNumber: 'DX-1102', poNumbers: ['2608-200002'], rate: '140', rateUnit: unit, quantity: unit === 'LOAD' ? '1' : '16' }),
  ];

  test("a line whose ticket names one load of the trip bills that load alone", () => {
    const [first, second] = trip();
    const decision = matchHaulLine(line({ ticketNumber: 'DX-1102', unitRate: 140 }), [first!, second!], { tolerances });
    assert.equal(decision.status, 'MATCHED', decision.reason);
    assert.deepEqual(decision.loadIds, [second!.id]);
    assert.equal(decision.orderId, second!.orderLineId);
    assert.equal(decision.totals?.agreedRate, 140);
    assert.match(check(decision, 'haulLoad')!.detail, /load 1 of trip T-30/);
    assert.equal(check(decision, 'haulQuantity')!.expected, 1);
  });

  test('two lines for the two loads of a trip both pass, each with its own load', () => {
    const loads = trip();
    const one = matchHaulLine(line({ id: 'line-1', ticketNumber: 'DX-1101', unitRate: 140 }), loads, { tolerances });
    const two = matchHaulLine(line({ id: 'line-2', ticketNumber: 'DX-1102', unitRate: 140 }), loads, {
      tolerances,
      // The first line's verdict is open: it counts another load, so it is no repeat.
      competingLines: [{ invoiceLineId: 'line-1', invoiceNumber: 'DX-301', lineNumber: 1, loadIds: one.loadIds }],
    });
    assert.equal(one.status, 'MATCHED', one.reason);
    assert.equal(two.status, 'MATCHED', two.reason);
    assert.deepEqual([...one.loadIds, ...two.loadIds], loads.map((entry) => entry.id));
    assert.equal(check(two, 'duplicateBilling'), undefined);
  });

  test("the first load paid does not make the trip's next load already paid", () => {
    const [first, second] = trip();
    first!.claimedByLineItemId = 'line-paid';
    first!.claim = { invoiceNumber: 'DX-300', lineNumber: 1 };
    const decision = matchHaulLine(line({ ticketNumber: 'DX-1102', unitRate: 140 }), [first!, second!], { tolerances });
    assert.equal(decision.status, 'MATCHED', decision.reason);
    assert.equal(check(decision, 'loadReuse')!.passed, true);
    assert.deepEqual(decision.loadIds, [second!.id]);
  });

  test('a load billed on its own line is refused again on a later whole-trip line', () => {
    const [first, second] = trip();
    first!.claimedByLineItemId = 'line-paid';
    first!.claim = { invoiceNumber: 'DX-300', lineNumber: 1 };
    const decision = matchHaulLine(line({ poNumber: '200002', unitRate: 140, quantity: 2 }), [first!, second!], { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    assert.deepEqual(decision.loadIds, [first!.id, second!.id]);
    const reuse = check(decision, 'loadReuse')!;
    assert.equal(reuse.code, 'LOAD_ALREADY_CLAIMED');
    assert.match(reuse.detail, /load 1 of trip T-30 was already paid on invoice DX-300 line 1/);
  });

  test('a whole-trip line and a line for one of its loads, both open, are double billing', () => {
    const loads = trip();
    const whole = matchHaulLine(line({ id: 'line-1', poNumber: '200001', unitRate: 140, quantity: 2 }), loads, { tolerances });
    assert.equal(whole.status, 'MATCHED', whole.reason);
    assert.equal(whole.loadIds.length, 2);
    const single = matchHaulLine(line({ id: 'line-2', ticketNumber: 'DX-1101', unitRate: 140 }), loads, {
      tolerances,
      competingLines: [{ invoiceLineId: 'line-1', invoiceNumber: 'DX-301', lineNumber: 1, loadIds: whole.loadIds }],
    });
    assert.deepEqual(single.loadIds, [loads[0]!.id]);
    assert.equal(single.status, 'PARTIAL');
    assert.equal(check(single, 'duplicateBilling')!.passed, false);
    assert.match(check(single, 'duplicateBilling')!.detail, /DX-301 line 1/);
  });

  test("a line quoting one load's ticket but billing the whole trip is the whole trip", () => {
    const loads = trip();
    const decision = matchHaulLine(line({ ticketNumber: 'DX-1101', unitRate: 140, quantity: 2 }), loads, { tolerances });
    assert.equal(decision.status, 'MATCHED', decision.reason);
    assert.deepEqual(decision.loadIds, loads.map((entry) => entry.id));
  });

  test('by the tonne, a load billed on its own is checked against its own tonnes', () => {
    const [first, second] = trip('TONNE');
    const decision = matchHaulLine(
      line({ ticketNumber: 'DX-1102', unit: 'tonnes', unitRate: 140, quantity: 16 }), [first!, second!], { tolerances }
    );
    assert.equal(decision.status, 'MATCHED', decision.reason);
    assert.deepEqual(decision.loadIds, [second!.id]);
    assert.equal(check(decision, 'haulQuantity')!.expected, 16);
    const whole = matchHaulLine(
      line({ ticketNumber: 'DX-1102', unit: 'tonnes', unitRate: 140, quantity: 30 }), [first!, second!], { tolerances }
    );
    assert.deepEqual(whole.loadIds, [first!.id, second!.id], '30 t is the whole trip, not the 16 t load');
  });

  test('a trip by the hour is billed whole whatever ticket the line quotes', () => {
    const loads = trip('HOUR');
    const decision = matchHaulLine(line({ ticketNumber: 'DX-1101', unit: 'hr', unitRate: 140, quantity: 6 }), loads, { tolerances });
    assert.deepEqual(decision.loadIds, loads.map((entry) => entry.id));
  });

  test('a ticket the trip shares names the trip, not one load', () => {
    const loads = trip();
    for (const entry of loads) entry.ticketNumber = 'DX-TRIP-9';
    const decision = matchHaulLine(line({ ticketNumber: 'DX-TRIP-9', unitRate: 140, quantity: 2 }), loads, { tolerances });
    assert.equal(decision.status, 'MATCHED', decision.reason);
    assert.deepEqual(decision.loadIds, loads.map((entry) => entry.id));
  });

  test("one load of a trip is checked against its own rate, though the trip's rates differ", () => {
    const [first, second] = trip();
    second!.rate = '150';
    const own = matchHaulLine(line({ ticketNumber: 'DX-1102', unitRate: 150 }), [first!, second!], { tolerances });
    assert.equal(own.status, 'MATCHED', own.reason);
    assert.equal(own.totals?.agreedRate, 150);
    // Billed whole, nobody can say which rate the trip is at.
    const whole = matchHaulLine(line({ poNumber: '200001', unitRate: 140, quantity: 2 }), [first!, second!], { tolerances });
    assert.equal(check(whole, 'haulRate')!.code, 'TRIP_RATES_DIFFER');
  });

  test("one load of a trip whose reference also falls on another day is still shown to a person", () => {
    const [first, second] = trip();
    const later = load({ tripRef: 'T-30', poNumbers: ['2608-200009'], rate: '140', haulDate: daysFrom(DAY, 2) });
    const decision = matchHaulLine(line({ ticketNumber: 'DX-1101', unitRate: 140 }), [first!, second!, later], { tolerances });
    assert.deepEqual(decision.loadIds, [first!.id]);
    const spans = check(decision, 'haulTrip')!;
    assert.equal(spans.code, 'TRIP_SPANS_DAYS');
    assert.equal(spans.found, 1, "the same day's other load is not another day");
    assert.match(spans.detail, /Only \d+ load 1 is counted on this line/);
  });
});

describe('the rate dispatch set', () => {
  test('billing exactly the dispatcher rate passes, and the approved rate is that rate', () => {
    const decision = matchHaulLine(line({ ticketNumber: 'T-101' }), [load({ ticketNumber: 'T-101' })], { tolerances });
    assert.equal(check(decision, 'haulRate')!.passed, true);
    assert.equal(decision.totals?.agreedRate, 185);
    assert.equal(decision.totals?.rateDiscrepancy, null);
  });

  test('1% either side is allowed; just past it is RATE_MISMATCH with both numbers', () => {
    const at = (unitRate: number) =>
      matchHaulLine(line({ ticketNumber: 'T-101', unitRate }), [load({ ticketNumber: 'T-101', rate: '200' })], { tolerances });
    assert.equal(at(202).status, 'MATCHED');
    assert.equal(at(198).status, 'MATCHED');
    const over = at(202.02);
    assert.equal(over.status, 'PARTIAL');
    const rate = check(over, 'haulRate')!;
    assert.equal(rate.code, 'RATE_MISMATCH');
    assert.equal(rate.expected, 200);
    assert.equal(rate.found, 202.02);
    assert.match(rate.detail, /\$202\.02.*\$200\.00/);
    assert.equal(over.totals?.rateDiscrepancy, 2.02);
    assert.equal(over.totals?.agreedRate, 200, 'the approved amount is still the dispatcher rate times the quantity');
    assert.equal(at(197.9).status, 'PARTIAL');
  });

  test('the tolerance comes from settings, and a bad setting falls back', () => {
    const wider = resolveHaulTolerances([{ key: 'match.haulPriceTolerancePct', value: '5' }]);
    const decision = matchHaulLine(
      line({ ticketNumber: 'T-101', unitRate: 208 }),
      [load({ ticketNumber: 'T-101', rate: '200' })],
      { tolerances: wider }
    );
    assert.equal(decision.status, 'MATCHED');
    assert.equal(resolveHaulTolerances([{ key: 'match.haulPriceTolerancePct', value: 'lots' }]).haulPriceTolerancePct, 1);
    assert.equal(resolveHaulTolerances([{ key: 'match.haulDateWindowDays', value: 90 }]).haulDateWindowDays, 7);
  });

  test('a rate per hour against a line billed per load is not compared', () => {
    const decision = matchHaulLine(
      line({ ticketNumber: 'T-101', unit: 'loads', unitRate: 120 }),
      [load({ ticketNumber: 'T-101', rate: '120', rateUnit: 'HOUR' })],
      { tolerances }
    );
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'haulRate')!.code, 'UNIT_MISMATCH');
    assert.equal(decision.totals?.rateUnitMismatch, true);
    assert.equal(decision.totals?.agreedRate, null);
  });

  test('a short ton is not a tonne', () => {
    const decision = matchHaulLine(
      line({ ticketNumber: 'T-101', unit: 'tons', unitRate: 9, quantity: 24 }),
      [load({ ticketNumber: 'T-101', rate: '9', rateUnit: 'TONNE' })],
      { tolerances }
    );
    assert.equal(check(decision, 'haulRate')!.code, 'UNIT_MISMATCH');
  });

  test('a load with no rate from dispatch is NO_RATE_SET and never passes', () => {
    const decision = matchHaulLine(
      line({ ticketNumber: 'T-101' }),
      [load({ ticketNumber: 'T-101', rate: null, rateUnit: null })],
      { tolerances }
    );
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'haulRate')!.code, 'NO_RATE_SET');
    assert.equal(decision.totals?.agreedRate, null);
    assert.deepEqual(decision.loadIds.length, 1);
  });
});

describe('the expected quantity', () => {
  test('a small difference from an estimate is noted, not held against the line', () => {
    const decision = matchHaulLine(
      line({ ticketNumber: 'T-101', unit: 'hours', unitRate: 120, quantity: 3.5 }),
      [load({ ticketNumber: 'T-101', rate: '120', rateUnit: 'HOUR', quantity: '3' })],
      { tolerances }
    );
    assert.equal(decision.status, 'MATCHED');
    assert.match(check(decision, 'haulQuantity')!.detail, /Noted only/);
  });

  test('far past the estimate stops the line', () => {
    const decision = matchHaulLine(
      line({ ticketNumber: 'T-101', unit: 'hours', unitRate: 120, quantity: 6 }),
      [load({ ticketNumber: 'T-101', rate: '120', rateUnit: 'HOUR', quantity: '3' })],
      { tolerances }
    );
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'haulQuantity')!.passed, false);
  });

  test('no expected quantity, no quantity check', () => {
    const decision = matchHaulLine(line({ ticketNumber: 'T-101' }), [load({ ticketNumber: 'T-101' })], { tolerances });
    assert.equal(check(decision, 'haulQuantity'), undefined);
  });
});

describe('a load is paid once', () => {
  test('a load another line paid is LOAD_ALREADY_CLAIMED and never passes', () => {
    const paid = load({
      ticketNumber: 'T-101',
      claimedByLineItemId: 'other-line',
      claim: { invoiceNumber: 'HAUL-0001', lineNumber: 2 },
    });
    const decision = matchHaulLine(line({ ticketNumber: 'T-101' }), [paid], { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    const reuse = check(decision, 'loadReuse')!;
    assert.equal(reuse.code, 'LOAD_ALREADY_CLAIMED');
    assert.match(reuse.detail, /HAUL-0001 line 2/);
  });

  test("this line's own claim is its own history, not a second payment", () => {
    const mine = load({ ticketNumber: 'T-101', claimedByLineItemId: 'line-1' });
    const decision = matchHaulLine(line({ ticketNumber: 'T-101' }), [mine], { tolerances });
    assert.equal(decision.status, 'MATCHED');
  });

  test('one paid load of a trip makes the whole trip paid', () => {
    const loads = [
      load({ tripRef: 'T-9', poNumbers: ['300001'], claimedByLineItemId: 'other-line', claim: { invoiceNumber: 'HAUL-0002', lineNumber: 1 } }),
      load({ tripRef: 'T-9', poNumbers: ['300002'] }),
    ];
    const decision = matchHaulLine(line({ poNumber: '300002' }), loads, { tolerances });
    assert.equal(check(decision, 'loadReuse')!.code, 'LOAD_ALREADY_CLAIMED');
  });

  test('the date fallback prefers an unpaid load to one already paid', () => {
    const paid = load({ claimedByLineItemId: 'other-line' });
    const free = load();
    const decision = matchHaulLine(line(), [paid, free], { tolerances });
    assert.deepEqual(decision.loadIds, [free.id]);
  });
});

describe('lines that are not a haul by themselves', () => {
  test('a fuel surcharge is never guessed onto a load by carrier and date', () => {
    const only = load();
    const surcharge = matchHaulLine(line({ unit: '%', unitRate: 12, quantity: 1 }), [only], { tolerances });
    assert.equal(surcharge.status, 'UNMATCHED');
    assert.deepEqual(surcharge.loadIds, [], 'confirming it must not claim the load');
    const flat = matchHaulLine(line({ unit: null }), [only], { tolerances });
    assert.deepEqual(flat.loadIds, []);
  });
});

describe('another unsettled line billing the same haul', () => {
  test('is reported on both, so neither is passed for being read first', () => {
    const only = load({ ticketNumber: 'T-101' });
    const decision = matchHaulLine(line({ ticketNumber: 'T-101' }), [only], {
      tolerances,
      competingLines: [{ invoiceLineId: 'line-9', invoiceNumber: 'HAUL-0009', lineNumber: 3, loadIds: [only.id] }],
    });
    assert.equal(decision.status, 'PARTIAL');
    const duplicate = check(decision, 'duplicateBilling')!;
    assert.equal(duplicate.passed, false);
    assert.match(duplicate.detail, /HAUL-0009 line 3/);
  });

  test("a line's own earlier verdict, or one on other loads, is not a competitor", () => {
    const only = load({ ticketNumber: 'T-101' });
    const decision = matchHaulLine(line({ ticketNumber: 'T-101' }), [only], {
      tolerances,
      competingLines: [
        { invoiceLineId: 'line-1', invoiceNumber: 'HAUL-0001', lineNumber: 1, loadIds: [only.id] },
        { invoiceLineId: 'line-9', invoiceNumber: 'HAUL-0009', lineNumber: 1, loadIds: ['some-other-load'] },
      ],
    });
    assert.equal(decision.status, 'MATCHED');
  });
});
