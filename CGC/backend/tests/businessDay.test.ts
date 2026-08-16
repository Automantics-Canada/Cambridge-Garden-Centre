/**
 * Day boundaries must follow Ontario time, not the host's clock and not UTC.
 *
 * The defect being pinned: with UTC boundaries, an order entered at 21:00 on
 * 15 August in Cambridge lands on the 16th, so it disappears from "Today" for
 * the rest of the working evening and turns up under tomorrow instead.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  businessDayOf,
  businessDayRange,
  endOfBusinessDay,
  startOfBusinessDay,
} from '../src/lib/businessDay.js';

describe('startOfBusinessDay', () => {
  it('starts a summer day at 04:00 UTC (EDT, UTC-4)', () => {
    assert.equal(
      startOfBusinessDay('2026-08-16')?.toISOString(),
      '2026-08-16T04:00:00.000Z'
    );
  });

  it('starts a winter day at 05:00 UTC (EST, UTC-5)', () => {
    assert.equal(
      startOfBusinessDay('2026-01-15')?.toISOString(),
      '2026-01-15T05:00:00.000Z'
    );
  });

  it('rejects anything that is not a calendar date', () => {
    // Callers must reject rather than fall through to an unfiltered query.
    for (const bad of ['', 'today', '2026-8-16', '2026-13-01', '2026-08-16T00:00:00Z']) {
      assert.equal(startOfBusinessDay(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('endOfBusinessDay', () => {
  it('ends one millisecond before the next day begins', () => {
    assert.equal(
      endOfBusinessDay('2026-08-16')?.toISOString(),
      '2026-08-17T03:59:59.999Z'
    );
  });

  it('covers the 23-hour day when the clocks go forward', () => {
    // 8 March 2026, 02:00 EST becomes 03:00 EDT: the day is 23 hours long.
    const start = startOfBusinessDay('2026-03-08')!;
    const end = endOfBusinessDay('2026-03-08')!;
    assert.equal(end.getTime() - start.getTime() + 1, 23 * 60 * 60 * 1000);
  });

  it('covers the 25-hour day when the clocks go back', () => {
    // 1 November 2026, 02:00 EDT becomes 01:00 EST: the day is 25 hours long.
    const start = startOfBusinessDay('2026-11-01')!;
    const end = endOfBusinessDay('2026-11-01')!;
    assert.equal(end.getTime() - start.getTime() + 1, 25 * 60 * 60 * 1000);
  });
});

describe('businessDayOf', () => {
  it('keeps a late Cambridge evening on the same calendar day', () => {
    // 21:00 EDT on the 15th is 01:00 UTC on the 16th. UTC would say the 16th.
    assert.equal(businessDayOf(new Date('2026-08-16T01:00:00.000Z')), '2026-08-15');
  });

  it('rolls over at local midnight, not UTC midnight', () => {
    assert.equal(businessDayOf(new Date('2026-08-16T03:59:59.999Z')), '2026-08-15');
    assert.equal(businessDayOf(new Date('2026-08-16T04:00:00.000Z')), '2026-08-16');
  });
});

describe('businessDayRange', () => {
  it('returns a range that contains the whole local day and nothing after it', () => {
    const range = businessDayRange('2026-08-16')!;
    assert.equal(range.gte.toISOString(), '2026-08-16T04:00:00.000Z');
    assert.equal(range.lte.toISOString(), '2026-08-17T03:59:59.999Z');
  });

  it('returns null rather than an open range for bad input', () => {
    assert.equal(businessDayRange('not-a-date'), null);
  });
});
