import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LoadInputError,
  applyLoadInput,
  billableHauls,
  changesRate,
  loadChanges,
  lockedChanges,
  parseLoadInput,
  type HaulLoad,
  type LoadState,
} from '../src/modules/dispatch/dispatchLoadRules.js';

/**
 * The rules a dispatch load's haul rate is kept by (client, Oct 2026, Q14),
 * without a database. Every id and name is invented.
 */

const CARRIER = '11111111-1111-4111-8111-111111111111';
const OTHER_CARRIER = '22222222-2222-4222-8222-222222222222';

const EMPTY: LoadState = {
  carrierSupplierId: null, driverId: null, rate: null, rateUnit: null, quantity: null,
  sourceSupplierId: null, tripRef: null, ticketNumber: null, notes: null,
};

describe('parseLoadInput', () => {
  it('reads only the fields it knows, and only those sent', () => {
    assert.deepEqual(parseLoadInput({ rate: '95.5', rateUnit: 'load', price: 1, setById: 'x' }), {
      rate: '95.5',
      rateUnit: 'LOAD',
    });
    assert.deepEqual(parseLoadInput({}), {});
  });

  it('takes a rate of 0 or more with up to four places, as text, and refuses the rest', () => {
    assert.equal(parseLoadInput({ rate: 0 }).rate, '0');
    assert.equal(parseLoadInput({ rate: ' 120.1250 ' }).rate, '120.1250');
    assert.equal(parseLoadInput({ rate: 87 }).rate, '87');
    for (const bad of ['-1', '1.23456', 'abc', '1e3', '$95', '123456789']) {
      assert.throws(() => parseLoadInput({ rate: bad }), LoadInputError, bad);
    }
    assert.throws(() => parseLoadInput({ rate: -5 }), LoadInputError);
    assert.throws(() => parseLoadInput({ rate: true }), LoadInputError);
  });

  it('clears a field sent empty', () => {
    assert.deepEqual(parseLoadInput({ rate: '', rateUnit: '', carrierSupplierId: '', tripRef: '  ', notes: null }), {
      rate: null, rateUnit: null, carrierSupplierId: null, tripRef: null, notes: null,
    });
  });

  it('knows only per load, per hour and per tonne', () => {
    assert.equal(parseLoadInput({ rateUnit: 'tonne' }).rateUnit, 'TONNE');
    assert.equal(parseLoadInput({ rateUnit: 'HOUR' }).rateUnit, 'HOUR');
    assert.throws(() => parseLoadInput({ rateUnit: 'ton' }), /per load, per hour or per tonne/);
    assert.throws(() => parseLoadInput({ rateUnit: 'trip' }), LoadInputError);
  });

  it('wants a positive expected quantity', () => {
    assert.equal(parseLoadInput({ quantity: '2.5' }).quantity, '2.5');
    assert.throws(() => parseLoadInput({ quantity: '0' }), /more than 0/);
    assert.throws(() => parseLoadInput({ quantity: '-2' }), LoadInputError);
  });

  it('refuses an id that is not one', () => {
    assert.equal(parseLoadInput({ carrierSupplierId: CARRIER }).carrierSupplierId, CARRIER);
    assert.throws(() => parseLoadInput({ carrierSupplierId: 'Example Haulage' }), /carrier/);
    assert.throws(() => parseLoadInput({ driverId: 42 }), /driver/);
    assert.throws(() => parseLoadInput({ sourceSupplierId: 'pit' }), /pit/);
  });

  it('tidies a trip reference to one spelling, and bounds the text fields', () => {
    assert.equal(parseLoadInput({ tripRef: '  t-12   a ' }).tripRef, 'T-12 A');
    assert.equal(parseLoadInput({ ticketNumber: ' 4471 ' }).ticketNumber, '4471');
    assert.throws(() => parseLoadInput({ tripRef: 'x'.repeat(41) }), /longer than 40/);
    assert.throws(() => parseLoadInput({ notes: 'x'.repeat(501) }), /longer than 500/);
    assert.throws(() => parseLoadInput({ notes: 5 }), /text/);
  });

  it('wants an object', () => {
    assert.throws(() => parseLoadInput(null), LoadInputError);
    assert.throws(() => parseLoadInput([]), LoadInputError);
  });
});

describe('applyLoadInput', () => {
  it('needs the unit whenever a rate is set', () => {
    assert.throws(() => applyLoadInput(EMPTY, { rate: '95' }), /per load, per hour or per tonne/);
    assert.deepEqual(applyLoadInput(EMPTY, { rate: '95', rateUnit: 'LOAD' }), { ...EMPTY, rate: '95', rateUnit: 'LOAD' });
    // Clearing the unit of a priced load is the same mistake.
    assert.throws(() => applyLoadInput({ ...EMPTY, rate: '95', rateUnit: 'LOAD' }, { rateUnit: null }), LoadInputError);
    // A unit with no rate yet is fine: the rate comes later.
    assert.equal(applyLoadInput(EMPTY, { rateUnit: 'HOUR' }).rateUnit, 'HOUR');
  });

  it('leaves the fields a request does not send', () => {
    const before = { ...EMPTY, carrierSupplierId: CARRIER, rate: '95', rateUnit: 'LOAD' as const, notes: 'Gate code 1234' };
    assert.deepEqual(applyLoadInput(before, { ticketNumber: '5521' }), { ...before, ticketNumber: '5521' });
  });
});

describe('loadChanges, lockedChanges and changesRate', () => {
  const priced: LoadState = { ...EMPTY, carrierSupplierId: CARRIER, rate: '95.0000', rateUnit: 'LOAD' };

  it('sees the same decimal written two ways as no change', () => {
    assert.deepEqual(loadChanges(priced, { ...priced, rate: '95' }), []);
  });

  it('lists each changed field with its old and new value', () => {
    assert.deepEqual(loadChanges(priced, { ...priced, rate: '110', notes: 'Waited an hour' }), [
      { field: 'rate', from: '95.0000', to: '110' },
      { field: 'notes', from: null, to: 'Waited an hour' },
    ]);
  });

  it('locks every figure of a paid load but its note', () => {
    assert.deepEqual(lockedChanges(loadChanges(priced, { ...priced, notes: 'Paid on INV-1' })), []);
    assert.deepEqual(lockedChanges(loadChanges(priced, { ...priced, rate: '90' })), ['rate']);
    assert.deepEqual(lockedChanges(loadChanges(priced, { ...priced, carrierSupplierId: OTHER_CARRIER })), ['carrierSupplierId']);
    assert.deepEqual(lockedChanges(loadChanges(priced, { ...priced, tripRef: 'T-1' })), ['tripRef']);
  });

  it('calls a change to the rate or its unit a rate change', () => {
    assert.equal(changesRate(loadChanges(priced, { ...priced, rateUnit: 'HOUR' })), true);
    assert.equal(changesRate(loadChanges(priced, { ...priced, ticketNumber: '1' })), false);
  });
});

describe('billableHauls', () => {
  const load = (id: string, extra: Partial<HaulLoad> = {}): HaulLoad => ({
    id, documentId: `doc-${id}`, carrierSupplierId: CARRIER, tripRef: null, rate: '95', rateUnit: 'LOAD',
    quantity: null, claimedByLineItemId: null, ...extra,
  });

  it('bills each load on its own, and never CGC\'s own trucks', () => {
    const hauls = billableHauls([load('a'), load('b', { quantity: '2' }), load('fleet', { carrierSupplierId: null })]);
    assert.deepEqual(hauls.map(haul => [haul.loadIds, haul.rate, haul.quantity]), [
      [['a'], '95', null],
      [['b'], '95', '2'],
    ]);
  });

  it('bills a brokered trip over several orders once, at the trip\'s rate, not the sum of its loads', () => {
    const [trip, ...rest] = billableHauls([
      load('a', { tripRef: 't-7' }),
      load('b', { tripRef: 'T-7' }),
      load('c', { tripRef: 'T-7', documentId: 'doc-a' }),
    ]);
    assert.equal(rest.length, 0);
    assert.deepEqual(trip, {
      carrierSupplierId: CARRIER,
      tripRef: 'T-7',
      loadIds: ['a', 'b', 'c'],
      documentIds: ['doc-a', 'doc-b'],
      rate: '95',
      rateUnit: 'LOAD',
      rateConflict: false,
      quantity: '1',
      claimed: false,
    });
  });

  it('adds up a trip by the tonne, and leaves a trip by the hour to the client\'s answer', () => {
    const [tonnes] = billableHauls([
      load('a', { tripRef: 'T-8', rateUnit: 'TONNE', rate: '6.5', quantity: '12.25' }),
      load('b', { tripRef: 'T-8', rateUnit: 'TONNE', rate: '6.50', quantity: '10.1' }),
    ]);
    assert.equal(tonnes!.quantity, '22.35');
    assert.equal(tonnes!.rate, '6.5');
    const [hours] = billableHauls([
      load('a', { tripRef: 'T-9', rateUnit: 'HOUR', quantity: '3' }),
      load('b', { tripRef: 'T-9', rateUnit: 'HOUR', quantity: '3' }),
    ]);
    assert.equal(hours!.quantity, null);
  });

  it('keeps one trip reference apart per carrier', () => {
    const hauls = billableHauls([load('a', { tripRef: 'T-1' }), load('b', { tripRef: 'T-1', carrierSupplierId: OTHER_CARRIER })]);
    assert.equal(hauls.length, 2);
  });

  it('gives no rate to a trip whose loads disagree, or that has none yet', () => {
    const [conflict] = billableHauls([load('a', { tripRef: 'T-2' }), load('b', { tripRef: 'T-2', rate: '110' })]);
    assert.equal(conflict!.rateConflict, true);
    assert.equal(conflict!.rate, null);
    const [unpriced] = billableHauls([load('a', { rate: null, rateUnit: null })]);
    assert.equal(unpriced!.rateConflict, false);
    assert.equal(unpriced!.rate, null);
  });

  it('counts a haul paid only once every load of it is', () => {
    const [half] = billableHauls([load('a', { tripRef: 'T-3', claimedByLineItemId: 'line-1' }), load('b', { tripRef: 'T-3' })]);
    assert.equal(half!.claimed, false);
    const [paid] = billableHauls([load('a', { claimedByLineItemId: 'line-1' })]);
    assert.equal(paid!.claimed, true);
  });
});
