import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  carriedOverWhere,
  dayOfDeliveryDate,
  deliveryDayDate,
  isPastDay,
  undatedWhere,
  upcomingDays,
  upcomingWhere,
} from '../src/modules/dispatch/dispatchDays.js';

const count = (iso: string | null, n: number) => ({
  deliveryDate: iso ? new Date(`${iso}T00:00:00.000Z`) : null,
  _count: { _all: n },
});

describe('board days', () => {
  it('treats only days before today as history', () => {
    assert.equal(isPastDay('2026-08-14', '2026-08-15'), true);
    assert.equal(isPastDay('2026-08-15', '2026-08-15'), false);
    assert.equal(isPastDay('2026-08-17', '2026-08-15'), false);
    // Across a month and a year, where a naive day-number comparison breaks.
    assert.equal(isPastDay('2026-09-30', '2026-10-01'), true);
    assert.equal(isPastDay('2026-12-31', '2027-01-01'), true);
  });

  it('compares delivery dates as calendar dates, not instants', () => {
    assert.equal(deliveryDayDate('2026-08-14').toISOString(), '2026-08-14T00:00:00.000Z');
    assert.equal(dayOfDeliveryDate(new Date('2026-08-14T00:00:00.000Z')), '2026-08-14');
  });

  it('carries over earlier orders with no driver and no finished stop, never pickups', () => {
    const where = carriedOverWhere('2026-08-15');
    assert.deepEqual(where.deliveryDate, { lt: new Date('2026-08-15T00:00:00.000Z') });
    assert.equal(where.isPickup, false);
    assert.deepEqual(where.OR, [
      { delivery: null },
      { delivery: { driverId: null, status: { notIn: ['DELIVERED', 'CANCELLED'] } } },
    ]);
  });

  it('counts only days after today as upcoming', () => {
    assert.deepEqual(upcomingWhere('2026-08-15'), {
      deliveryDate: { gt: new Date('2026-08-15T00:00:00.000Z') },
      isPickup: false,
    });
  });

  it('lists pickups and open undated deliveries, searched by number or customer', () => {
    assert.deepEqual(undatedWhere(), { OR: [{ isPickup: true }, { deliveryDate: null, NOT: { flags: { has: 'NOT_OPEN' } } }] });
    assert.deepEqual(undatedWhere('   '), { OR: [{ isPickup: true }, { deliveryDate: null, NOT: { flags: { has: 'NOT_OPEN' } } }] });
    assert.deepEqual(undatedWhere(' 712589 ').AND, [
      { OR: [{ isPickup: true }, { deliveryDate: null, NOT: { flags: { has: 'NOT_OPEN' } } }] },
      {
        OR: [
          { documentNumber: { contains: '712589', mode: 'insensitive' } },
          { customerName: { contains: '712589', mode: 'insensitive' } },
        ],
      },
    ]);
  });
});

describe('upcoming days', () => {
  it('gives each day its total and what still needs a driver, soonest first', () => {
    const days = upcomingDays(
      [count('2026-08-31', 1), count('2026-08-17', 2), count('2026-08-19', 1)],
      [count('2026-08-17', 1), count('2026-08-31', 1)],
    );
    assert.deepEqual(days, [
      { date: '2026-08-17', count: 2, unassigned: 1 },
      { date: '2026-08-19', count: 1, unassigned: 0 },
      { date: '2026-08-31', count: 1, unassigned: 1 },
    ]);
  });

  it('ignores a group with no date', () => {
    assert.deepEqual(upcomingDays([count(null, 3)], [count(null, 3)]), []);
  });
});
