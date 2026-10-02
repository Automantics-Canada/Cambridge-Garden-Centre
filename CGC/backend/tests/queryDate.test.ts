import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCalendarDateRange, parseQueryDate, QueryDateError } from '../src/lib/queryDate.js';

describe('parseQueryDate', () => {
  it('uses the start of the Cambridge day for a date input', () => {
    assert.equal(
      parseQueryDate('2026-08-19', 'startDate', 'start')?.toISOString(),
      '2026-08-19T04:00:00.000Z'
    );
  });

  it('uses the end of the Cambridge day for a date input', () => {
    assert.equal(
      parseQueryDate('2026-08-19', 'endDate', 'end')?.toISOString(),
      '2026-08-20T03:59:59.999Z'
    );
  });

  it('keeps an explicit timestamp exact', () => {
    assert.equal(
      parseQueryDate('2026-08-19T12:34:56.000Z', 'startDate', 'start')?.toISOString(),
      '2026-08-19T12:34:56.000Z'
    );
  });

  it('rejects an invalid date with a client-error type', () => {
    for (const value of ['not-a-date', '2026-02-31']) {
      assert.throws(
        () => parseQueryDate(value, 'startDate', 'start'),
        (error: unknown) => error instanceof QueryDateError && error.status === 400
      );
    }
  });
});

describe('parseCalendarDateRange', () => {
  it('keeps a one-day filter on a calendar date to that day', () => {
    const { startDate, endDate } = parseCalendarDateRange('2026-08-14', '2026-08-14');
    assert.equal(startDate?.toISOString(), '2026-08-14T00:00:00.000Z');
    assert.equal(endDate?.toISOString(), '2026-08-14T00:00:00.000Z');

    // How Postgres compares a stored @db.Date against the bounds.
    const stored = (day: string) => new Date(`${day}T00:00:00.000Z`);
    const inRange = (day: string) => stored(day) >= startDate! && stored(day) <= endDate!;
    assert.equal(inRange('2026-08-14'), true);
    assert.equal(inRange('2026-08-15'), false, 'the next day is not in a one-day filter');
    assert.equal(inRange('2026-08-13'), false);
  });

  it('leaves out an end that was not given, and rejects a bad date', () => {
    assert.equal(parseCalendarDateRange('2026-08-14', undefined).endDate, undefined);
    assert.throws(() => parseCalendarDateRange('2026-02-31', ''), QueryDateError);
  });
});
