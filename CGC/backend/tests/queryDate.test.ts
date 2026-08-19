import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQueryDate, QueryDateError } from '../src/lib/queryDate.js';

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
