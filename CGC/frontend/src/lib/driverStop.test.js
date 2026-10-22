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
      // Stock from CGC's own yard: nowhere else to load.
      pickups: [],
      // This stop came without a pickup list, so the yard is not claimed.
      pickupAtYard: false,
      pickupAtPit: false,
    });
  });

  it("sends the driver to the pit, not CGC's yard, where the order names no supplier (2610-721420)", () => {
    const view = stopView({
      order: { spruceOrderId: '2610-721420-L1' },
      document: { documentNumber: '2610-721420', customerName: 'Restivo Landscaping', lines: [] },
      pickupFrom: [],
      pickupAtPit: true,
    });
    expect(view.pickupAtPit).toBe(true);
    expect(view.pickupAtYard).toBe(false);
  });

  it("tells the driver to load at CGC's yard when no supplier is involved", () => {
    const view = stopView({
      order: { spruceOrderId: '2610-721420-L1' },
      document: { documentNumber: '2610-721420', customerName: 'Restivo Landscaping', lines: [] },
      pickupFrom: [],
    });
    expect(view.pickupAtYard).toBe(true);
    expect(view.pickups).toEqual([]);
  });

  it('says where to load a bought-in order first, and the PO to quote there', () => {
    const view = stopView({
      order: { spruceOrderId: '2608-712595-L1' },
      document: { documentNumber: '2608-712595', customerName: 'OHS Landscape Group', lines: [] },
      pickupFrom: [
        { name: 'Unilock', location: 'Georgetown', address: null, po: '2608-355356' },
        { name: 'UNMAPPED01', address: null, po: '2608-355357' },
      ],
    });
    expect(view.pickups).toEqual([
      { name: 'Unilock', location: 'Georgetown', address: null, po: '2608-355356' },
      { name: 'UNMAPPED01', location: null, address: null, po: '2608-355357' },
    ]);
    expect(view.pickupAtYard).toBe(false);
  });

  it('keeps two products under one catch-all code apart (2608-712621)', () => {
    const view = stopView({
      order: {},
      document: {
        documentNumber: '2608-712621',
        customerName: 'TMC MASONRY',
        lines: [
          { spruceItemNumber: 'MISC', product: 'Quikrete Type S Bulk Bag 1362 KG', quantity: '4', unit: 'EA', lineClass: 'PRODUCT' },
          { spruceItemNumber: 'MSKID', product: 'Miscellaneous Skid Deposit', quantity: '4', unit: 'EA', lineClass: 'DEPOSIT' },
          { spruceItemNumber: 'MISC', product: 'Quikrete Spec Mix Corefill Grout Fine 1362 KG Bags', quantity: '6', unit: 'EA', lineClass: 'PRODUCT' },
          { spruceItemNumber: 'MISC', product: 'Energy Surcharge', quantity: '10', unit: 'EA', lineClass: 'FEE' },
        ],
      },
    });
    expect(view.lines).toEqual([
      { product: 'Quikrete Type S Bulk Bag 1362 KG', quantity: '4', unit: 'EA' },
      { product: 'Quikrete Spec Mix Corefill Grout Fine 1362 KG Bags', quantity: '6', unit: 'EA' },
    ]);
  });

  it('puts repeated loads of one item on one line, with how many loads', () => {
    const load = { spruceItemNumber: 'AGG01', product: 'Agg "B" Type 1 PitBlk (MT)', quantity: '40', unit: 'MT', lineClass: 'PRODUCT' };
    const view = stopView({
      order: {},
      document: {
        documentNumber: '2608-712556',
        customerName: 'Twin City Interloc Inc.',
        lines: [load, load, load, load, load, load, { spruceItemNumber: 'SAND', product: 'Sand', quantity: '2', unit: 'MT', lineClass: 'PRODUCT' }],
      },
    });
    expect(view.lines).toEqual([
      { product: 'Agg "B" Type 1 PitBlk (MT)', quantity: 240, unit: 'MT', loads: 6 },
      { product: 'Sand', quantity: '2', unit: 'MT' },
    ]);
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
