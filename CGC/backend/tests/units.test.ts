/**
 * Two prices may only be compared when they price the same unit.
 *
 * The defect pinned here: a rate agreed at $8.10 per tonne was compared
 * directly against $9.10 per short ton and reported as a clean ten percent
 * overcharge. The units differ by about that much, so the "discrepancy" was
 * the conversion, not the supplier.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareUnits, normaliseUnit } from '../src/lib/units.js';

describe('normaliseUnit', () => {
  it('folds spelling, casing and punctuation onto one code', () => {
    for (const raw of ['tonne', 'Tonnes', 'MT', ' mt ', 'metric ton', 'metric-tons']) {
      assert.equal(normaliseUnit(raw), 'TONNE', `expected TONNE for ${JSON.stringify(raw)}`);
    }
    for (const raw of ['CY', 'cu yd', 'cubic yard', 'Cubic Yards']) {
      assert.equal(normaliseUnit(raw), 'CUBIC_YARD', `expected CUBIC_YARD for ${JSON.stringify(raw)}`);
    }
  });

  it('keeps the metric tonne and the short ton apart', () => {
    // They differ by ~10%. Folding them together is the bug this file exists for.
    assert.equal(normaliseUnit('tonne'), 'TONNE');
    assert.equal(normaliseUnit('ton'), 'SHORT_TON');
    assert.notEqual(normaliseUnit('tonne'), normaliseUnit('ton'));
  });

  it('returns null for anything it does not recognise', () => {
    for (const raw of [null, undefined, '', '   ', '???', 'buckets']) {
      assert.equal(normaliseUnit(raw), null, `expected null for ${JSON.stringify(raw)}`);
    }
  });
});

describe('compareUnits', () => {
  it('allows comparison when both sides mean the same unit', () => {
    assert.deepEqual(compareUnits('MT', 'tonnes'), { comparable: true, unit: 'TONNE' });
  });

  it('refuses tonne against short ton', () => {
    const result = compareUnits('ton', 'tonne');
    assert.equal(result.comparable, false);
    assert.equal(result.comparable === false && result.reason, 'DIFFERENT');
  });

  it('refuses when either side is unrecognised, and reports the raw text', () => {
    const result = compareUnits('buckets', 'tonne');
    assert.equal(result.comparable, false);
    assert.equal(result.comparable === false && result.reason, 'UNRECOGNISED');
    assert.equal(result.comparable === false && result.reason === 'UNRECOGNISED' && result.invoiceUnit, 'buckets');
  });

  it('refuses a missing unit rather than assuming a default', () => {
    // 'ea' was the silent default for a missing invoice unit; defaulting on one
    // side and comparing anyway is how a per-tonne rate got applied per item.
    assert.equal(compareUnits(null, 'tonne').comparable, false);
    assert.equal(compareUnits('tonne', null).comparable, false);
  });
});
