import { describe, expect, it } from 'vitest';

import { stopView, telHref } from './driverStop';

describe('stopView', () => {
  it('gives the driver the whole order: where, who, what, and dispatch\'s note', () => {
    const view = stopView({
      order: { spruceOrderId: '2608-700001-L1', product: 'Clear Stone' },
      document: {
        documentNumber: '2608-700001',
        customerName: 'Pat Example',
        phone: '519-555-0100',
        shippingAddress: '64 Example St,Kitchener',
        addressNormalized: '64 Example St, Kitchener',
        deliveryInstructions: 'CUSTOMER ON SITE',
        dispatcherNotes: 'Gate code 4411',
        deliveryType: 'SLINGER',
        lines: [
          { product: 'Clear Stone', quantity: '12', unit: 'MT', lineClass: 'PRODUCT' },
          { product: 'Slinger Spreading', quantity: '12', unit: 'MT', lineClass: 'DELIVERY_CHARGE' },
          { product: 'Skid Deposit', quantity: '2', unit: 'EA', lineClass: 'DEPOSIT' },
        ],
      },
    });

    expect(view).toEqual({
      orderNumber: '2608-700001',
      customerName: 'Pat Example',
      phone: '519-555-0100',
      address: '64 Example St, Kitchener',
      instructions: 'CUSTOMER ON SITE',
      notes: 'Gate code 4411',
      deliveryType: 'Slinger',
      lines: [{ product: 'Clear Stone', quantity: '12', unit: 'MT' }],
      skids: 2,
    });
  });

  it('shows a stop made before orders were dispatched whole as its one line', () => {
    const view = stopView({
      order: { spruceOrderId: 'OLD-1', customerName: 'Old Customer', product: 'Soil', quantity: '3', unit: 'CY', document: { shippingAddress: '1 Old Rd' } },
      document: null,
    });
    expect(view.orderNumber).toBe('OLD-1');
    expect(view.address).toBe('1 Old Rd');
    expect(view.lines).toEqual([{ product: 'Soil', quantity: '3', unit: 'CY' }]);
  });
});

describe('telHref', () => {
  it('dials the number, then the extension after a pause', () => {
    expect(telHref('519-621-5491 EXT.1')).toBe('tel:5196215491,1');
    expect(telHref('(519) 744-7719')).toBe('tel:5197447719');
    expect(telHref(null)).toBeNull();
  });
});
