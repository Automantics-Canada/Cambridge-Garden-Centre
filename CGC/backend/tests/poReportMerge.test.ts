import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planPoLineMerge,
  type PoReportLine,
  type StoredPoLine,
} from '../src/modules/orders/poReportMerge.service.js';

function reportLine(
  poNumber: string,
  quantity: number,
  rowNumber: number,
  vendorCode = 'VENDOR01'
): PoReportLine {
  return {
    documentNumber: '2608-700001',
    poNumber,
    itemNumber: 'USKID',
    product: 'Unilock Skid Deposit',
    quantity,
    vendorCode,
    pageNumber: 1,
    rowNumber,
  };
}

function storedLine(
  id: string,
  quantity: number,
  options: Partial<StoredPoLine> = {}
): StoredPoLine {
  return {
    id,
    product: 'Unilock Skid Deposit',
    quantity,
    unit: null,
    spruceItemNumber: 'USKID',
    lineNumber: null,
    poNumber: null,
    supplierId: null,
    hasOperationalLinks: false,
    ...options,
  };
}

describe('planPoLineMerge', () => {
  it('consumes repeated item-code rows one-to-one by quantity', () => {
    const lines = [
      reportLine('PO-SMALL', 1, 10),
      reportLine('PO-LARGE', 6, 11),
    ];
    const stored = [
      storedLine('large', 6),
      storedLine('small', 1),
    ];

    const plan = planPoLineMerge(
      lines,
      stored,
      new Map([['VENDOR01', 'supplier-1']])
    );

    assert.deepEqual(plan.ambiguous, []);
    assert.deepEqual(plan.unmatched, []);
    assert.deepEqual(
      plan.updates.map(update => [update.orderId, update.poNumber]),
      [['small', 'PO-SMALL'], ['large', 'PO-LARGE']]
    );
  });

  it('uses existing POs to preserve identical linked rows across reordered reports', () => {
    const lines = [
      reportLine('PO-B', 1, 10),
      reportLine('PO-A', 1, 11),
    ];
    const stored = [
      storedLine('a', 1, { poNumber: 'PO-A', hasOperationalLinks: true }),
      storedLine('b', 1, { poNumber: 'PO-B', hasOperationalLinks: true }),
    ];

    const plan = planPoLineMerge(lines, stored, new Map());

    assert.deepEqual(plan.ambiguous, []);
    assert.deepEqual(
      plan.updates.map(update => update.orderId),
      ['b', 'a']
    );
  });

  it('reports an operational duplicate instead of assigning a PO arbitrarily', () => {
    const plan = planPoLineMerge(
      [reportLine('PO-A', 1, 10)],
      [
        storedLine('linked', 1, { hasOperationalLinks: true }),
        storedLine('plain', 1),
      ],
      new Map()
    );

    assert.equal(plan.updates.length, 0);
    assert.equal(plan.ambiguous.length, 1);
  });

  it('marks existing PO and supplier changes as approval conflicts', () => {
    const plan = planPoLineMerge(
      [reportLine('PO-NEW', 1, 10)],
      [storedLine('line', 1, { poNumber: 'PO-OLD', supplierId: 'supplier-old' })],
      new Map([['VENDOR01', 'supplier-new']])
    );

    assert.equal(plan.updates.length, 1);
    assert.equal(plan.updates[0]!.poConflict, true);
    assert.equal(plan.updates[0]!.supplierConflict, true);
  });
});
