import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '@prisma/client';

import {
  DISPATCH_DOCUMENT_SELECT,
  awaitingSupplierByOrder,
  awaitingSupplierOf,
  representativeLineId,
  toDispatchOrder,
  withAwaitingSupplier,
  withUpdatedFields,
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

  it('starts with no fields marked Updated', () => {
    assert.deepEqual(toDispatchOrder(document([{}])).updatedFields, []);
  });
});

describe('orders Spruce changed today', () => {
  /** Answers like the database would: one change today on doc-1. */
  function fakeDb(seen: { ids?: string[]; range?: { gte: Date; lte: Date } }) {
    return {
      orderChange: {
        findMany: async ({ where }: { where: { documentId: { in: string[] }; createdAt: { gte: Date; lte: Date } } }) => {
          seen.ids = where.documentId.in;
          seen.range = where.createdAt;
          return where.documentId.in.includes('doc-1')
            ? [{ documentId: 'doc-1', lineId: null, field: 'shippingAddress', oldValue: 'A St', newValue: 'B St', createdAt: new Date() }]
            : [];
        },
      },
      orderOverride: { findMany: async () => [] },
    } as unknown as Parameters<typeof withUpdatedFields>[0];
  }

  it('marks them wherever the board holds them, in one read', async () => {
    const pooled = toDispatchOrder(document([{}]));
    const onRun = { ...toDispatchOrder(document([{}])), id: 'doc-2' };
    const olderStop = { id: 'line-9', wholeOrder: false as const };
    const seen: { ids?: string[]; range?: { gte: Date; lte: Date } } = {};

    const board = await withUpdatedFields(fakeDb(seen), {
      carriedOver: [],
      unassignedOrders: [pooled],
      drivers: [{ deliveries: [{ order: onRun }, { order: olderStop }] }],
    }, '2026-09-02');

    assert.deepEqual(seen.ids, ['doc-1', 'doc-2'], 'whole orders only, in one query');
    assert.deepEqual(board.unassignedOrders[0], { ...pooled, updatedFields: ['shippingAddress'] });
    assert.deepEqual(onRun.updatedFields, []);
    assert.equal('updatedFields' in olderStop, false);
    // Today in Cambridge: 9/2 starts at 04:00 UTC in summer.
    assert.equal(seen.range?.gte.toISOString(), '2026-09-02T04:00:00.000Z');
  });

  it('marks a plain list of rows too', async () => {
    const rows = [toDispatchOrder(document([{}]))];
    await withUpdatedFields(fakeDb({}), rows, '2026-09-02');
    assert.deepEqual(rows[0]!.updatedFields, ['shippingAddress']);
  });
});

describe('who an order is awaiting', () => {
  it('names the supplier and PO, falling back to the vendor code', () => {
    assert.deepEqual(awaitingSupplierOf([
      { poNumber: '9900-100001', vendorCode: 'EXAMPLEV01', supplierName: 'Example Pavers' },
      { poNumber: '9900-100001', vendorCode: 'EXAMPLEV01', supplierName: 'Example Pavers' },
      { poNumber: null, vendorCode: 'EXAMPLEV01', supplierName: 'Example Pavers' },
      { poNumber: ' 9900-100002 ', vendorCode: 'SAMPLEV02', supplierName: null },
      { poNumber: '9900-100003', vendorCode: null, supplierName: null },
    ]), [
      { supplierName: 'Example Pavers', poNumber: '9900-100001' },
      { supplierName: 'SAMPLEV02', poNumber: '9900-100002' },
      { supplierName: null, poNumber: '9900-100003' },
    ]);
  });

  it('is empty for an order with no PO lines', () => {
    assert.deepEqual(awaitingSupplierOf([{ poNumber: null, vendorCode: null, supplierName: null }]), []);
  });

  /** Answers like the database would; records what was asked. */
  function fakeDb(seen: { lineIds?: string[]; codes?: string[] }) {
    const lines = [
      { documentId: 'doc-1', poNumber: '9900-100001', vendorCode: 'EXAMPLEV01', supplier: null },
      { documentId: 'doc-1', poNumber: '9900-100001', vendorCode: 'EXAMPLEV01', supplier: null },
      { documentId: 'doc-2', poNumber: '9900-100002', vendorCode: 'SAMPLEV02', supplier: { name: 'Sample Stone' } },
      { documentId: 'doc-2', poNumber: '9900-100004', vendorCode: 'NEWVEND01', supplier: null },
    ];
    return {
      order: {
        findMany: async ({ where }: { where: { documentId: { in: string[] } } }) => {
          seen.lineIds = where.documentId.in;
          return lines.filter(line => where.documentId.in.includes(line.documentId));
        },
      },
      supplierSpruceVendor: {
        findMany: async ({ where }: { where: { code: { in: string[] } } }) => {
          seen.codes = where.code.in;
          return where.code.in.includes('EXAMPLEV01') ? [{ code: 'EXAMPLEV01', supplier: { name: 'Example Pavers' } }] : [];
        },
      },
    } as unknown as Parameters<typeof awaitingSupplierByOrder>[0];
  }

  it('reads only orders flagged as awaiting, and names suppliers through the vendor mapping', async () => {
    const seen: { lineIds?: string[]; codes?: string[] } = {};
    const awaiting = await awaitingSupplierByOrder(fakeDb(seen), [
      { id: 'doc-1', flags: ['AWAITING_SUPPLIER'] },
      { id: 'doc-2', flags: ['AWAITING_SUPPLIER', 'SMALL_TRUCK'] },
      { id: 'doc-3', flags: ['NO_ADDRESS'] },
    ]);

    assert.deepEqual(seen.lineIds, ['doc-1', 'doc-2']);
    assert.deepEqual(seen.codes, ['EXAMPLEV01', 'NEWVEND01'], 'only codes the line has no supplier for');
    assert.deepEqual(awaiting.get('doc-1'), [{ supplierName: 'Example Pavers', poNumber: '9900-100001' }]);
    assert.deepEqual(awaiting.get('doc-2'), [
      { supplierName: 'Sample Stone', poNumber: '9900-100002' },
      { supplierName: 'NEWVEND01', poNumber: '9900-100004' },
    ]);
    assert.deepEqual(awaiting.get('doc-3'), []);
  });

  it('asks nothing when no order is awaiting a supplier', async () => {
    const seen: { lineIds?: string[] } = {};
    const awaiting = await awaitingSupplierByOrder(fakeDb(seen), [{ id: 'doc-1', flags: [] }]);
    assert.equal(seen.lineIds, undefined);
    assert.deepEqual(awaiting.get('doc-1'), []);
  });

  it('fills every whole order a board holds, and leaves older stops alone', async () => {
    const pooled = { ...toDispatchOrder(document([{}])), flags: ['AWAITING_SUPPLIER'] };
    const onRun = { ...toDispatchOrder(document([{}])), id: 'doc-3' };
    const olderStop = { id: 'line-9', wholeOrder: false as const };

    await withAwaitingSupplier(fakeDb({}), {
      unassignedOrders: [pooled],
      drivers: [{ deliveries: [{ order: onRun }, { order: olderStop }] }],
    });

    assert.deepEqual(pooled.awaitingSupplier, [{ supplierName: 'Example Pavers', poNumber: '9900-100001' }]);
    assert.deepEqual(onRun.awaitingSupplier, []);
    assert.equal('awaitingSupplier' in olderStop, false);
  });

  it("is not part of the row itself, so a driver's stop never carries it", () => {
    assert.equal('awaitingSupplier' in toDispatchOrder(document([{}])), false);
    assert.equal('supplier' in DISPATCH_DOCUMENT_SELECT.lines.select, false);
    assert.equal('poNumber' in DISPATCH_DOCUMENT_SELECT.lines.select, false);
    assert.equal('vendorCode' in DISPATCH_DOCUMENT_SELECT.lines.select, false);
    assert.equal('poNumber' in DISPATCH_DOCUMENT_SELECT, false);
  });
});
