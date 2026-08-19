import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatQuantity } from '../src/lib/quantity.js';

describe('formatQuantity', () => {
  it('does not turn missing or invalid values into zero', () => {
    assert.equal(formatQuantity(null, 'ton'), 'Not recorded');
    assert.equal(formatQuantity(undefined, 'ton'), 'Not recorded');
    assert.equal(formatQuantity('not-a-number', 'ton'), 'Not recorded');
  });

  it('keeps real zeroes and omits a missing unit honestly', () => {
    assert.equal(formatQuantity(0, 'ton'), '0 ton');
    assert.equal(formatQuantity('12.50', null), '12.5');
  });
});
