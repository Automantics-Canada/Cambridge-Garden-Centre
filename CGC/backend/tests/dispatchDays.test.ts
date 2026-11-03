import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  carriedOverWhere,
  dayOfDeliveryDate,
  dayPoolWhere,
  deliveryDayDate,
  isPastDay,
  todayPoolWhere,
  undatedWhere,
  upcomingDays,
  upcomingWhere,
  upcomingWithoutDriverWhere,
  uploadedOnWhere,
} from '../src/modules/dispatch/dispatchDays.js';

const QUOTE = { flags: { has: 'QUOTE' } };
// No stop, or one with no driver that is not finished: a delivered or
// cancelled stop whose driver was removed is history, not work.
const WITHOUT_DRIVER = {
  OR: [{ delivery: null }, { delivery: { driverId: null, status: { notIn: ['DELIVERED', 'CANCELLED'] } } }],
};

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

  it("counts an upload in Cambridge's day, first import or re-upload", () => {
    // 2026-08-15 runs 04:00Z to 03:59:59.999Z the next day in EDT.
    const range = {
      gte: new Date('2026-08-15T04:00:00.000Z'),
      lte: new Date('2026-08-16T03:59:59.999Z'),
    };
    assert.deepEqual(uploadedOnWhere('2026-08-15'), {
      OR: [{ createdAt: range }, { lastBatch: { is: { createdAt: range } } }],
    });
    assert.throws(() => uploadedOnWhere('2026-02-31'), /Invalid date/);
  });

  it("pools today's deliveries and today's upload that have no driver, never pickups or quotations", () => {
    const where = todayPoolWhere('2026-08-15');
    assert.equal(where.isPickup, false);
    // At the top, so a quotation Item Tracking dated today stays out as well.
    assert.deepEqual(where.NOT, QUOTE);
    assert.deepEqual(where.AND, [
      WITHOUT_DRIVER,
      {
        OR: [
          { deliveryDate: new Date('2026-08-15T00:00:00.000Z') },
          // An upload Spruce no longer lists as open is waiting for nothing.
          { AND: [uploadedOnWhere('2026-08-15'), { NOT: { flags: { hasSome: ['NOT_OPEN', 'QUOTE'] } } }] },
        ],
      },
    ]);
  });

  it("carries over earlier orders with no driver and no finished stop, never pickups, closed ones or today's upload", () => {
    const where = carriedOverWhere('2026-08-15');
    assert.deepEqual(where.deliveryDate, { lt: new Date('2026-08-15T00:00:00.000Z') });
    assert.equal(where.isPickup, false);
    // Spruce has invoiced, closed or voided a NOT_OPEN order: nothing to carry.
    // One in today's upload is in today's pool instead.
    assert.deepEqual(where.NOT, [{ flags: { hasSome: ['NOT_OPEN', 'QUOTE'] } }, uploadedOnWhere('2026-08-15')]);
    assert.deepEqual(where.OR, WITHOUT_DRIVER.OR);
  });

  it("pools another day's deliveries with no driver, never pickups or quotations", () => {
    assert.deepEqual(dayPoolWhere('2026-08-19'), {
      deliveryDate: new Date('2026-08-19T00:00:00.000Z'),
      isPickup: false,
      NOT: QUOTE,
      ...WITHOUT_DRIVER,
    });
  });

  it('counts only days after today as upcoming, never quotations', () => {
    const upcoming = {
      deliveryDate: { gt: new Date('2026-08-15T00:00:00.000Z') },
      isPickup: false,
      NOT: QUOTE,
    };
    assert.deepEqual(upcomingWhere('2026-08-15'), upcoming);
    assert.deepEqual(upcomingWithoutDriverWhere('2026-08-15'), { ...upcoming, ...WITHOUT_DRIVER });
  });

  it('lists open pickups and open undated deliveries, searched by number or customer', () => {
    // NOT_OPEN and QUOTE leave out a pickup as well as an undated delivery,
    // and a finished stop is done whether or not Spruce dated it.
    const open = {
      NOT: [
        { flags: { hasSome: ['NOT_OPEN', 'QUOTE'] } },
        { delivery: { status: { in: ['DELIVERED', 'CANCELLED'] } } },
      ],
      OR: [{ isPickup: true }, { deliveryDate: null }],
    };
    assert.deepEqual(undatedWhere(), open);
    assert.deepEqual(undatedWhere('   '), open);
    assert.deepEqual(undatedWhere(' 712589 ').AND, [
      open,
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
