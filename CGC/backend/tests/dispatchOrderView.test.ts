import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '@prisma/client';

import {
  DISPATCH_DOCUMENT_SELECT,
  representativeLineId,
  toDispatchOrder,
  type DispatchDocument,
} from '../src/modules/dispatch/dispatchOrderView.js';

/** A synthetic order; every value is invented. */
function document(lines: Array<Partial<DispatchDocument['lines'][number]>>): DispatchDocument {
  return {
    id: 'doc-1',
    documentNumber: '9900-000001',
    customerName: 'Pat Example',
    deliveryDate: new Date('2026-09-02T00:00:00Z'),
    shippingAddress: '64 Example St,Kitchener',
    addressNormalized: '64 Example St, Kitchener',
    phone: '519-555-0100',
    deliveryInstructions: 'CUSTOMER ON SITE',
    deliveryType: 'SLINGER',
    flags: ['CUSTOMER_ON_SITE'],
    dispatcherNotes: null,
    createdAt: new Date('2026-09-01T12:00:00Z'),
    _count: { overrides: 0 },
    lines: lines.map((line, index) => ({
      id: `line-${index + 1}`,
      product: 'Synthetic Product',
      quantity: new Prisma.Decimal(1),
      unit: 'EA',
      spruceItemNumber: 'ITEM',
      lineClass: null,
      lineNumber: index + 1,
      ...line,
    })),
  };
}

describe('a whole order on the dispatch board', () => {
  it('draws one row for the order, in the shape the board already reads', () => {
    const view = toDispatchOrder(document([
      { spruceItemNumber: 'AGG3/4C', product: '3/4" Clear PitBlk (MT)', quantity: new Prisma.Decimal(12), unit: 'MT' },
      { spruceItemNumber: 'MISCDELG', product: 'Slinger Spreading', quantity: new Prisma.Decimal(12), unit: 'MT' },
    ]));

    assert.equal(view.id, 'doc-1');
    assert.equal(view.wholeOrder, true);
    assert.equal(view.spruceOrderId, '9900-000001');
    assert.equal(view.product, '3/4" Clear PitBlk (MT)', 'the delivery charge is not a product');
    assert.equal(view.quantity, 12);
    assert.equal(view.unit, 'MT');
    assert.equal(view.address, '64 Example St, Kitchener');
    assert.equal(view.deliveryType, 'SLINGER');
    assert.deepEqual(view.lines.map(line => line.itemCode), ['AGG3/4C']);
  });

  it('adds up products that share a unit, as six loads of 40 tonnes are 240', () => {
    const view = toDispatchOrder(document(
      Array.from({ length: 6 }, () => ({ spruceItemNumber: 'AGG01', product: 'Type 1 (MT)', quantity: new Prisma.Decimal(40), unit: 'MT' }))
    ));

    assert.equal(view.quantity, 240);
    assert.equal(view.product, 'Type 1 (MT) +5 more');
    assert.equal(view.lines.length, 6, 'every load stays listed');
  });

  it('shows the first product\'s quantity when units differ, and counts skids apart', () => {
    const view = toDispatchOrder(document([
      { spruceItemNumber: 'P90OKA', product: 'Pavers', quantity: new Prisma.Decimal('170.66'), unit: 'SQFT' },
      { spruceItemNumber: 'COMMENT', product: '2 skids', unit: '-' },
      { spruceItemNumber: 'RSKID', product: 'Skid Deposit', quantity: new Prisma.Decimal(2), unit: 'EA' },
      { spruceItemNumber: 'PSSBL', product: 'Polymeric Sand', quantity: new Prisma.Decimal(2), unit: 'BAG' },
    ]));

    assert.equal(view.quantity, 170.66);
    assert.equal(view.unit, 'SQFT');
    assert.equal(view.skids, 2);
    assert.equal(view.product, 'Pavers +1 more');
  });

  it('files the stop under the first product, not the delivery charge', () => {
    const order = document([{ spruceItemNumber: 'MISCDEL' }, { spruceItemNumber: 'SOILGRDNA' }]);
    assert.equal(representativeLineId(order), 'line-2');
    assert.equal(representativeLineId(document([{ spruceItemNumber: 'MISCDEL' }])), 'line-1');
    assert.equal(representativeLineId(document([])), null);
  });

  it('selects nothing about money, since the row reaches drivers\' screens', () => {
    const selected = JSON.stringify(DISPATCH_DOCUMENT_SELECT);
    for (const key of ['unitPrice', 'unitCost', 'poValue', 'totalWithTax', 'remaining', 'grossMarginPct', 'supplier']) {
      assert.equal(selected.includes(`"${key}"`), false, `${key} must not be selected`);
    }
  });
});
