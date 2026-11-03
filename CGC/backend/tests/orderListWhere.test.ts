/**
 * The Orders page's filters, as the where clause they build. Pure, so it
 * needs no database; orderDocumentList.integration.test.ts runs the same
 * filters against PostgreSQL.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOrderListWhere } from '../src/modules/orders/orderList.service.js';

const NOT_A_QUOTE = { NOT: { flags: { has: 'QUOTE' } } };

describe('the Orders list where clause', () => {
  it('leaves quotations out by default, and lists only them for the Quotations view', () => {
    assert.deepEqual(buildOrderListWhere({}), { AND: [NOT_A_QUOTE] });
    assert.deepEqual(buildOrderListWhere({ quotes: '' }), { AND: [NOT_A_QUOTE] });
    assert.deepEqual(buildOrderListWhere({ quotes: 'exclude' }), { AND: [NOT_A_QUOTE] });
    assert.deepEqual(buildOrderListWhere({ quotes: 'only' }), { AND: [{ flags: { has: 'QUOTE' } }] });
    assert.deepEqual(buildOrderListWhere({ quotes: 'only', fulfilment: 'pickup' }), {
      AND: [{ flags: { has: 'QUOTE' } }, { isPickup: true }],
    });
  });

  it('finds deliveries that were on a Deliveries report with no phone, null or empty', () => {
    assert.deepEqual(buildOrderListWhere({ missing: 'phone' }), {
      AND: [
        NOT_A_QUOTE,
        { isPickup: false, sourceReports: { has: 'DELIVERY' }, OR: [{ phone: null }, { phone: '' }] },
      ],
    });
  });

  it('refuses a view or a missing field it does not know, rather than listing everything', () => {
    for (const filters of [{ quotes: 'all' }, { quotes: 'hasOwnProperty' }, { missing: 'address' }, { missing: '__proto__' }]) {
      assert.throws(() => buildOrderListWhere(filters), (err: any) => err.status === 400, JSON.stringify(filters));
    }
  });
});
