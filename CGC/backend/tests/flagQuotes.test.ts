import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Refusal,
  assertMayWrite,
  describeTarget,
  isQuoteCandidate,
  parseOptions,
  quoteFlags,
  type StoredDocument,
} from '../src/scripts/flagQuotes.js';

/**
 * The quotation backfill's rule and its guards. It writes to whatever
 * database it is pointed at, so the guards matter as much as the rule.
 * Every value is invented.
 */

const quiet = { deliveries: 0, tickets: 0, lineItems: 0, ticketMatches: 0 };

function document(overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    id: 'doc-1',
    documentNumber: '9900-000009',
    customerName: 'Synthetic Customer',
    orderDate: null,
    deliveryDate: null,
    flags: ['NOT_OPEN'],
    sourceReports: ['ITEM_TRACKING'],
    isPickup: false,
    delivery: null,
    lines: [{ poNumber: null, driverId: null, hasInvoice: false, _count: quiet }],
    ...overrides,
  };
}

describe('flagQuotes', () => {
  it('is a dry run unless --apply, and reads the allowlist and host', () => {
    assert.deepEqual(parseOptions([]), { apply: false, confirmHost: null, documents: null, help: false });
    assert.deepEqual(parseOptions(['--apply', '--confirm-host=db.example.test', '--documents=9900-000001, 9900-000002']), {
      apply: true,
      confirmHost: 'db.example.test',
      documents: ['9900-000001', '9900-000002'],
      help: false,
    });
    assert.throws(() => parseOptions(['--aply']), Refusal);
    assert.throws(() => parseOptions(['--documents=']), Refusal);
  });

  it('writes to a loopback database, or to another only when the host is named exactly', () => {
    assert.doesNotThrow(() => assertMayWrite('127.0.0.1', null));
    assert.doesNotThrow(() => assertMayWrite('localhost', null));
    assert.throws(() => assertMayWrite('db.example.test', null), Refusal);
    assert.throws(() => assertMayWrite('db.example.test', 'other.example.test'), Refusal);
    assert.doesNotThrow(() => assertMayWrite('db.example.test', 'db.example.test'));
  });

  it('refuses a missing or non-PostgreSQL DATABASE_URL, and never echoes the password', () => {
    assert.throws(() => describeTarget(undefined), Refusal);
    assert.throws(() => describeTarget('mysql://u:p@127.0.0.1/db'), Refusal);
    assert.deepEqual(describeTarget('postgresql://user:secret@127.0.0.1:55432/cgc_test'), {
      host: '127.0.0.1',
      port: '55432',
      database: 'cgc_test',
    });
  });

  it('takes only an Item-Tracking-only document with no history for a quotation', () => {
    assert.equal(isQuoteCandidate(document()), true);
    assert.equal(isQuoteCandidate(document({ flags: [] })), true, 'NOT_OPEN is not required');
    assert.equal(isQuoteCandidate(document({ flags: ['QUOTE'] })), false, 'already flagged');
    assert.equal(isQuoteCandidate(document({ sourceReports: ['ITEM_TRACKING', 'ORDER_SUMMARY'] })), false);
    assert.equal(isQuoteCandidate(document({ sourceReports: ['DELIVERY', 'ITEM_TRACKING'] })), false);
    assert.equal(isQuoteCandidate(document({ delivery: { id: 'stop-1' } })), false);
    const line = document().lines[0]!;
    assert.equal(isQuoteCandidate(document({ lines: [{ ...line, poNumber: '9900-300001' }] })), false);
    assert.equal(isQuoteCandidate(document({ lines: [{ ...line, driverId: 'driver-1' }] })), false);
    assert.equal(isQuoteCandidate(document({ lines: [{ ...line, hasInvoice: true }] })), false);
    assert.equal(isQuoteCandidate(document({ lines: [{ ...line, _count: { ...quiet, tickets: 1 } }] })), false);
  });

  it('adds QUOTE in place of NOT_OPEN and keeps every other flag', () => {
    assert.deepEqual(quoteFlags(['NOT_OPEN']), ['QUOTE']);
    assert.deepEqual(quoteFlags(['DATE_MISMATCH', 'NOT_OPEN']), ['DATE_MISMATCH', 'QUOTE']);
    assert.deepEqual(quoteFlags([]), ['QUOTE']);
    assert.deepEqual(quoteFlags(['SPRUCE_VALUE_CHANGED', 'NOT_OPEN']), ['QUOTE', 'SPRUCE_VALUE_CHANGED'], 'in the order the import stores');
    assert.deepEqual(quoteFlags(['SOMETHING_RETIRED']), ['QUOTE', 'SOMETHING_RETIRED'], 'nothing unknown dropped');
    // The import raises no state flag on a quotation; the backfill agrees.
    assert.deepEqual(quoteFlags(['NO_ADDRESS', 'NO_PHONE', 'NOT_OPEN', 'READ_DIFFERENTLY']), ['READ_DIFFERENTLY', 'QUOTE']);
  });
});
