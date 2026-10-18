import { describe, expect, it } from 'vitest';

import { formatOrderQuantity } from './quantity';
import { awaitingSupplierText, supplierWithYard } from './dispatchBoard';
import { deliveryStatusView } from './orderList';
import { flagInfo } from './spruceImport';

describe('order quantities across units', () => {
  it('lists every unit when the products are in more than one', () => {
    expect(formatOrderQuantity({ quantity: 2.5, unit: 'CY', quantities: [{ quantity: 2.5, unit: 'CY' }, { quantity: 4, unit: 'EA' }] }))
      .toBe('2.5 CY + 4 EA');
  });

  it('shows the one total otherwise, and copes with an order sent before totals were listed', () => {
    expect(formatOrderQuantity({ quantity: 2.5, unit: 'CY', quantities: [{ quantity: 2.5, unit: 'CY' }] })).toBe('2.5 CY');
    expect(formatOrderQuantity({ quantity: 12, unit: 'MT' })).toBe('12 MT');
  });
});

describe("the supplier's yard", () => {
  it('names the yard the report gives, unless the name already says it', () => {
    expect(supplierWithYard('Bestway', 'Woodbridge')).toBe('Bestway - Woodbridge');
    expect(supplierWithYard('Unilock Ltd - Ayr', 'Ayr')).toBe('Unilock Ltd - Ayr');
    expect(supplierWithYard('BESTWAYS01', 'Woodbridge')).toBe('BESTWAYS01 - Woodbridge');
    expect(supplierWithYard('Unilock', null)).toBe('Unilock');
  });

  it('is on the Awaiting supplier badge', () => {
    expect(awaitingSupplierText({ awaitingSupplier: [{ supplierName: 'Unilock Ltd - Ayr', location: 'Georgetown', poNumber: '2608-355356' }] }))
      .toBe('Awaiting supplier: Unilock Ltd - Ayr - Georgetown PO 2608-355356');
  });
});

describe('where a pickup is collected', () => {
  it("says the supplier when Spruce says the pickup is direct, the yard otherwise", () => {
    expect(deliveryStatusView({ isPickup: true, collectAt: 'Quikrete' }).label).toBe('Pickup at Quikrete');
    expect(deliveryStatusView({ isPickup: true, collectAt: null }).label).toBe('Pickup at yard');
  });
});

describe('the new flags', () => {
  it('say why an address is missing, and name a missing phone and a date before entry', () => {
    expect(flagInfo('NOT_IN_ITEM_TRACKING').label).toBe('No address: not in Item Tracking export');
    expect(flagInfo('NO_PHONE').label).toBe('No phone');
    expect(flagInfo('DELIVERY_BEFORE_ENTRY').label).toBe('Delivery date before order date');
  });
});
