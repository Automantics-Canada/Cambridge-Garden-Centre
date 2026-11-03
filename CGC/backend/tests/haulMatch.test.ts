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
 * rate above what dispatch agreed, a trip paid once per order, a load paid
 * twice, a guess passed off as a match. Every name and number is invented.
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
    load({ tripRef: 'T-12', poNumbers: ['2608-100001'], quantity: '20', rate: '150', rateUnit: 'LOAD' }),
    load({ tripRef: 'T-12', poNumbers: ['2608-100002'], quantity: '18', rate: '150', rateUnit: 'LOAD' }),
    load({ tripRef: 'T-12', poNumbers: ['2608-100003'], rate: '150', rateUnit: 'LOAD' }),
  ];

  test('one invoice line at the trip rate covers every load of the trip', () => {
    const loads = trip();
    const decision = matchHaulLine(line({ poNumber: '100002', unitRate: 150 }), loads, { tolerances });
    assert.equal(decision.status, 'MATCHED');
    assert.deepEqual(decision.loadIds, loads.map((entry) => entry.id));
    assert.equal(decision.totals?.agreedRate, 150);
  });

  test('billing the trip once per order is three loads where dispatch expected one', () => {
    const decision = matchHaulLine(line({ poNumber: '100002', unitRate: 150, quantity: 3 }), trip(), { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    const quantity = check(decision, 'haulQuantity')!;
    assert.equal(quantity.passed, false);
    assert.equal(quantity.expected, 1);
    assert.equal(decision.totals?.quantityDiscrepancy, 2);
  });

  test('a trip whose loads carry different rates is for dispatch to settle', () => {
    const loads = trip();
    loads[1]!.rate = '160';
    const decision = matchHaulLine(line({ poNumber: '100001', unitRate: 150 }), loads, { tolerances });
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'haulRate')!.code, 'TRIP_RATES_DIFFER');
  });

  test('a trip reference reused on another day is another trip', () => {
    const today = load({ tripRef: 'T-12', poNumbers: ['2608-100001'], ticketNumber: 'T-500' });
    const later = load({ tripRef: 'T-12', poNumbers: ['2608-100009'], haulDate: daysFrom(DAY, 2) });
    const decision = matchHaulLine(line({ ticketNumber: 'T-500' }), [today, later], { tolerances });
    assert.equal(decision.status, 'MATCHED');
    assert.deepEqual(decision.loadIds, [today.id], 'the later day must not be paid with this line');
  });

  test('a trip reference reused the next week does not match at all', () => {
    const nextWeek = load({ tripRef: 'T-12', poNumbers: ['2608-100001'], haulDate: daysFrom(DAY, 9) });
    const decision = matchHaulLine(line({ poNumber: '100001' }), [nextWeek], { tolerances });
    assert.equal(decision.status, 'UNMATCHED');
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
