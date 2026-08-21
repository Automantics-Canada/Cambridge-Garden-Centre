/**
 * The defect pinned here: `new Date('05/06/24')` resolves month-first in V8,
 * so a Canadian report reading 5 June was stored as 6 May. The explicit parser
 * replaced the engine's guess — and its own convention is month-first, because
 * Spruce prints American dates (`8/14/2026` for 14 August). A day-first
 * reading of the same convention turned September 2 into February 9, which is
 * the regression the ambiguous-date tests below pin shut.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSpruceDate } from '../src/lib/spruceDate.js';

const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

describe('parseSpruceDate', () => {
  it('reads an ambiguous slash date month-first, as Spruce prints it', () => {
    assert.equal(iso(parseSpruceDate('05/06/24')), '2024-05-06');
  });

  it('stores the sample reports’ dates as the day they name', () => {
    // The exact strings carried by the three real reports. Under the previous
    // day-first convention these became February and May.
    assert.equal(iso(parseSpruceDate('9/2/2026')), '2026-09-02');
    assert.equal(iso(parseSpruceDate('9/5/2026')), '2026-09-05');
    assert.equal(iso(parseSpruceDate('8/14/2026')), '2026-08-14');
    assert.equal(iso(parseSpruceDate('08/17/26')), '2026-08-17');
  });

  it('uses the out-of-range half to settle the order without guessing', () => {
    assert.equal(iso(parseSpruceDate('25/06/24')), '2024-06-25'); // 25 cannot be a month
    assert.equal(iso(parseSpruceDate('06/25/24')), '2024-06-25'); // nor can it second
  });

  it('accepts ISO unchanged', () => {
    assert.equal(iso(parseSpruceDate('2024-06-05')), '2024-06-05');
    assert.equal(iso(parseSpruceDate('2024/06/05')), '2024-06-05');
  });

  it('accepts named months in either order', () => {
    assert.equal(iso(parseSpruceDate('5 Jun 2024')), '2024-06-05');
    assert.equal(iso(parseSpruceDate('Jun 5, 2024')), '2024-06-05');
    assert.equal(iso(parseSpruceDate('5-June-24')), '2024-06-05');
  });

  it('expands two-digit years either side of the 70 cutoff', () => {
    assert.equal(iso(parseSpruceDate('01/01/24')), '2024-01-01');
    assert.equal(iso(parseSpruceDate('01/01/99')), '1999-01-01');
  });

  it('rejects a date that does not exist instead of rolling it forward', () => {
    // Date would turn 31 February into 3 March and store it without complaint.
    assert.equal(parseSpruceDate('31/02/24'), null);
    assert.equal(parseSpruceDate('32/01/24'), null);
    // Neither half can be a month, so there is no reading of this to guess at.
    assert.equal(parseSpruceDate('13/13/24'), null);
  });

  it('resolves 13/05/24 as 13 May, since 13 cannot be a month', () => {
    // Month-first is only the tiebreak. When one half is out of range for a
    // month, that settles the reading regardless of the convention.
    assert.equal(iso(parseSpruceDate('13/05/24')), '2024-05-13');
  });

  it('returns null for text that is not a date', () => {
    for (const bad of [null, undefined, '', '   ', 'n/a', 'TOTAL', '123456']) {
      assert.equal(parseSpruceDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  it('never returns an Invalid Date', () => {
    for (const raw of ['05/06/24', '2024-06-05', 'Jun 5, 2024', 'rubbish']) {
      const parsed = parseSpruceDate(raw);
      if (parsed !== null) assert.ok(!Number.isNaN(parsed.getTime()), `Invalid Date from ${raw}`);
    }
  });
});
