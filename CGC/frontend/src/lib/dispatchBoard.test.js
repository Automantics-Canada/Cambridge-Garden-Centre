import { describe, expect, it } from 'vitest';
import {
  assignWarning,
  awaitingSupplierDetail,
  awaitingSupplierText,
  canMarkDoneOutside,
  doneOutsideConfirm,
  flagBadges,
  LIKELY_DELIVERED_TITLE,
  splitLikelyDelivered,
  flagLabel,
  mergeUnassignedOrders,
  orderRef,
  stopSummary,
  updatedTitle,
} from './dispatchBoard';

describe("today's orders most likely delivered already", () => {
  it('takes them out of the day\'s work into their own group, in order', () => {
    const work = [{ id: 'a' }, { id: 'c', likelyDelivered: false }];
    const done = [{ id: 'b', likelyDelivered: true }, { id: 'd', likelyDelivered: true }];
    expect(splitLikelyDelivered([work[0], done[0], work[1], done[1]])).toEqual({ work, likelyDelivered: done });
    expect(splitLikelyDelivered()).toEqual({ work: [], likelyDelivered: [] });
    expect(LIKELY_DELIVERED_TITLE).toBe("Likely already delivered (not on today's Deliveries report)");
  });

  it('can be marked done outside the app unless a driver has it on the truck or it is finished', () => {
    const order = { id: 'doc-1', wholeOrder: true, spruceOrderId: '9900-000601' };
    expect(canMarkDoneOutside(order)).toBe(true);
    expect(canMarkDoneOutside(order, 'PLACED')).toBe(true);
    for (const status of ['OUT_FOR_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED']) {
      expect(canMarkDoneOutside(order, status)).toBe(false);
    }
    expect(canMarkDoneOutside({ id: 'line-1', wholeOrder: false })).toBe(false);
    expect(doneOutsideConfirm(order)).toMatch(/^Mark 9900-000601 as delivered outside the app\?/);
  });
});

describe('mergeUnassignedOrders', () => {
  it('returns unassigned deliveries to the dispatch pool', () => {
    const waiting = { id: 'order-new', spruceOrderId: 'NEW-1' };
    const previouslyAssigned = { id: 'order-returned', spruceOrderId: 'RETURNED-1' };

    expect(mergeUnassignedOrders(
      [waiting],
      [{ id: 'delivery-1', order: previouslyAssigned }],
    )).toEqual([waiting, previouslyAssigned]);
  });

  it('deduplicates an order present in both API collections', () => {
    const order = { id: 'order-1', spruceOrderId: 'ONE' };

    expect(mergeUnassignedOrders([order], [{ id: 'delivery-1', order }])).toEqual([order]);
  });
});

describe('whole orders on the board', () => {
  it('names a whole order by its document, and an older stop by its line', () => {
    expect(orderRef({ id: 'doc-1', wholeOrder: true })).toEqual({ documentId: 'doc-1' });
    expect(orderRef({ id: 'line-1', wholeOrder: false })).toEqual({ orderId: 'line-1' });
  });

  it('asks before handing out an order that may not be ready, and only then', () => {
    expect(assignWarning({ spruceOrderId: '2608-700001', flags: ['NO_ADDRESS', 'SMALL_TRUCK'] }))
      .toBe('2608-700001: No address. Assign anyway?');
    expect(assignWarning({ spruceOrderId: '2608-700001', flags: ['SMALL_TRUCK', 'CUSTOMER_ON_SITE'] })).toBeNull();
    expect(assignWarning({ spruceOrderId: '2608-700001' })).toBeNull();
  });

  it('puts the flags that need attention first', () => {
    expect(flagBadges({ flags: ['SMALL_TRUCK', 'CHECK_ADDRESS'] }).map((badge) => badge.label))
      .toEqual(['Check address', 'Small truck']);
  });
});

describe('stopSummary', () => {
  it('summarises a stop by its whole order', () => {
    const stop = {
      order: { spruceOrderId: '2608-700001-L2', product: 'Type 1', quantity: '40', unit: 'MT' },
      document: {
        documentNumber: '2608-700001',
        customerName: 'Pat Example',
        lines: [
          { product: 'Delivery Charge', quantity: '1', unit: 'EA', lineClass: 'DELIVERY_CHARGE' },
          { product: 'Type 1', quantity: '40', unit: 'MT', lineClass: 'PRODUCT' },
          { product: 'Type 1', quantity: '40', unit: 'MT', lineClass: 'PRODUCT' },
        ],
      },
    };

    expect(stopSummary(stop)).toEqual({
      spruceOrderId: '2608-700001',
      customerName: 'Pat Example',
      product: 'Type 1 +1 more',
      quantity: 80,
      unit: 'MT',
    });
  });

  it('shows the line itself for a stop made before orders were dispatched whole', () => {
    const order = { spruceOrderId: 'OLD-1', product: 'Soil', quantity: '3', unit: 'CY' };
    expect(stopSummary({ order, document: null })).toBe(order);
  });
});

describe('orders the reports changed today', () => {
  it('names the changed fields under the Updated badge', () => {
    expect(updatedTitle({ updatedFields: ['shippingAddress', 'quantity', 'lineAdded'] }))
      .toBe("Changed by today's upload: Delivery address, Quantity, Item added");
  });

  it('shows no badge for an order nothing changed on, or a stop from before', () => {
    expect(updatedTitle({ updatedFields: [] })).toBeNull();
    expect(updatedTitle({ id: 'line-1', wholeOrder: false })).toBeNull();
  });

  it('names a field it has no word for by its code rather than not at all', () => {
    expect(updatedTitle({ updatedFields: ['somethingNew'] })).toBe("Changed by today's upload: somethingNew");
  });
});

describe('awaiting supplier', () => {
  it('names the supplier and PO, as the spec words it', () => {
    const order = {
      flags: ['AWAITING_SUPPLIER'],
      awaitingSupplier: [{ supplierName: 'Example Pavers', poNumber: '9900-100001' }],
    };
    expect(awaitingSupplierText(order)).toBe('Awaiting supplier: Example Pavers PO 9900-100001');
    expect(flagBadges(order)).toEqual([
      { flag: 'AWAITING_SUPPLIER', label: 'Awaiting supplier: Example Pavers PO 9900-100001', tone: 'neutral' },
    ]);
  });

  it('joins several POs, and shows a vendor code or a bare PO as it is', () => {
    expect(awaitingSupplierText({
      awaitingSupplier: [
        { supplierName: 'Example Pavers', poNumber: '9900-100001' },
        { supplierName: 'SAMPLEV02', poNumber: '9900-100002' },
        { supplierName: null, poNumber: '9900-100003' },
      ],
    })).toBe('Awaiting supplier: Example Pavers PO 9900-100001, SAMPLEV02 PO 9900-100002, PO 9900-100003');
  });

  it('says just "Awaiting supplier" when nothing is named', () => {
    expect(awaitingSupplierText({ flags: ['AWAITING_SUPPLIER'] })).toBe('Awaiting supplier');
    expect(awaitingSupplierText({ awaitingSupplier: [] })).toBe('Awaiting supplier');
    expect(awaitingSupplierDetail({ awaitingSupplier: [] })).toBe(null);
  });

  it('gives the board the supplier and PO alone, for the line under the badge', () => {
    expect(awaitingSupplierDetail({
      awaitingSupplier: [{ supplierName: 'Example Pavers', poNumber: '9900-100001' }],
    })).toBe('Example Pavers PO 9900-100001');
  });

  it("leaves every other flag's label alone", () => {
    const order = { awaitingSupplier: [{ supplierName: 'Example Pavers', poNumber: '9900-100001' }] };
    expect(flagLabel(order, 'SMALL_TRUCK')).toBe('Small truck');
    expect(flagLabel(order, 'AWAITING_SUPPLIER')).toBe('Awaiting supplier: Example Pavers PO 9900-100001');
  });
});
