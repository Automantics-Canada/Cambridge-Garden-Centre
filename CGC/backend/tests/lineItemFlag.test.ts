import './setupEnv.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveLineItemFlag, type LineItemFacts } from '../src/lib/lineItemFlag.js';

/**
 * The one-word verdict beside an invoice line.
 *
 * It is what a person scanning a ten-line invoice actually reads, so the cases
 * that matter are the ones where it could look better than the facts: a line
 * with a live rate warning that somebody has just attached an order to, and a
 * line nothing has evaluated at all.
 */

/** A line where every check passed. */
function clean(overrides: Partial<LineItemFacts> = {}): LineItemFacts {
  return {
    hasOrder: true,
    ticketCount: 1,
    hasQuantityDiscrepancy: false,
    hasRateDiscrepancy: false,
    hasAgreedRate: true,
    rateUnitMismatch: false,
    ...overrides,
  };
}

describe('deriveLineItemFlag', () => {
  test('a line with an order, a ticket and an applied rate is OK', () => {
    assert.equal(deriveLineItemFlag(clean()), 'OK');
  });

  test('one problem is named', () => {
    assert.equal(deriveLineItemFlag(clean({ hasOrder: false })), 'NO_ORDER');
    assert.equal(deriveLineItemFlag(clean({ ticketCount: 0 })), 'NO_TICKET');
    assert.equal(deriveLineItemFlag(clean({ hasQuantityDiscrepancy: true })), 'QTY_MISMATCH');
    assert.equal(deriveLineItemFlag(clean({ hasRateDiscrepancy: true })), 'RATE_MISMATCH');
  });

  test('two problems send the reader to the evidence rather than picking one', () => {
    assert.equal(
      deriveLineItemFlag(clean({ hasOrder: false, hasRateDiscrepancy: true })),
      'MULTIPLE_FLAGS'
    );
  });

  test('no rate on file is not the same as a rate in the wrong unit', () => {
    // One is fixed by agreeing a price, the other by correcting a unit, and
    // sending a clerk after the wrong one wastes the only attention this line
    // is going to get.
    assert.equal(deriveLineItemFlag(clean({ hasAgreedRate: false })), 'RATE_UNKNOWN');
    assert.equal(
      deriveLineItemFlag(clean({ hasAgreedRate: false, rateUnitMismatch: true })),
      'UNIT_MISMATCH'
    );
  });

  test('a rate discrepancy outranks the unit question, because a rate was applied', () => {
    assert.equal(
      deriveLineItemFlag(clean({ hasRateDiscrepancy: true, rateUnitMismatch: true })),
      'RATE_MISMATCH'
    );
  });

  test('a line nothing has evaluated never reads as OK', () => {
    // The state a freshly extracted line is written in, and the state it stays
    // in if matching fails. It must not be indistinguishable from a pass.
    const flag = deriveLineItemFlag({
      hasOrder: false,
      ticketCount: 0,
      hasQuantityDiscrepancy: false,
      hasRateDiscrepancy: false,
      hasAgreedRate: false,
      rateUnitMismatch: false,
    });
    assert.equal(flag, 'MULTIPLE_FLAGS');
    assert.notEqual(flag, 'OK');
  });
});
