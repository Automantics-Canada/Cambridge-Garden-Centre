// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import {
  awaitingSupplierOf,
  collectAtOf,
  quantityTotals,
  sameProductKey,
  toDispatchOrder,
  type DispatchDocument,
} from '../src/modules/dispatch/dispatchOrderView.js';
import { stateFlags } from '../src/modules/orders/import/mergeOrderFacts.js';
import { inferUnitFromDescription } from '../src/modules/orders/orderPdfImport.service.js';

/**
 * The manager's QA of the Oct 13 import (25 orders), one test per finding,
 * each on the order it was found on. Every value here is the report's own.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function order(lines: Array<Partial<DispatchDocument['lines'][number]>>): DispatchDocument {
  return {
    id: 'doc-1',
    documentNumber: '2608-700001',
    customerName: 'Customer',
    deliveryDate: day('2026-10-13'),
    shippingAddress: null,
    addressNormalized: null,
    phone: null,
    deliveryInstructions: null,
    deliveryType: null,
    flags: [],
    dispatcherNotes: null,
    createdAt: day('2026-10-18'),
    _count: { overrides: 0 },
    lines: lines.map((line, index) => ({
      id: `line-${index}`,
      product: 'Product',
      quantity: new Prisma.Decimal(1),
      unit: 'EA',
      spruceItemNumber: null,
      lineClass: null,
      lineNumber: index + 1,
      ...line,
    })),
  };
}

describe('QA bugs 1 and 2: half yards add to the yards', () => {
  it('2608-712622: 1 CY + 1 HCY + 1 CY is 2.5 CY, the line after the page break included', () => {
    const view = toDispatchOrder(order([
      { spruceItemNumber: 'AGG3/4A', product: 'Agg 3/4" Clear YrdBlk 1CY', unit: 'CY' },
      { spruceItemNumber: 'AGG3/4B', product: 'Agg 3/4" Clear YrdBlk 1HCY', unit: 'HCY' },
      { spruceItemNumber: 'AGGSTNEDUSTA', product: 'Agg Stone Dust YrdBlk 1CY', unit: 'CY' },
      { spruceItemNumber: 'MISCDELI', product: 'Splitbox Delivery', unit: 'EA' },
    ]));
    assert.deepEqual(view.quantities, [{ quantity: 2.5, unit: 'CY' }]);
    assert.equal(view.quantity, 2.5);
    assert.equal(view.product, 'Agg 3/4" Clear YrdBlk 1CY +2 more');
  });

  it('2608-712500: 4 CY + 1 HCY is 4.5 CY', () => {
    assert.deepEqual(quantityTotals([{ quantity: 4, unit: 'CY' }, { quantity: 1, unit: 'HCY' }]), [{ quantity: 4.5, unit: 'CY' }]);
  });

  it('keeps every unit where they cannot be added', () => {
    assert.deepEqual(
      quantityTotals([{ quantity: 170.66, unit: 'SQFT' }, { quantity: 2, unit: 'BAG' }, { quantity: null, unit: 'EA' }]),
      [{ quantity: 170.66, unit: 'SQFT' }, { quantity: 2, unit: 'BAG' }]
    );
  });
});

describe('QA bug 3: a direct pickup is collected at the supplier', () => {
  it('2608-712621: "Pickup direct pricing @ Quikrete." is collected at Quikrete', () => {
    assert.equal(collectAtOf([{ product: '**Pickup direct pricing @ Quikrete.**', lineClass: 'COMMENT' }]), 'Quikrete');
    const view = toDispatchOrder(order([
      { spruceItemNumber: 'COMMENT', product: '**Pickup direct pricing @ Quikrete.**', lineClass: 'COMMENT' },
      { spruceItemNumber: 'MISC', product: 'Quikrete Type S Bulk Bag 1362 KG', quantity: new Prisma.Decimal(4) },
    ]));
    assert.equal(view.collectAt, 'Quikrete');
  });

  it('is the yard when no comment says otherwise, and only comments count', () => {
    assert.equal(collectAtOf([{ product: 'Pickup @ CGC Yard', lineClass: 'PRODUCT' }]), null);
    assert.equal(collectAtOf([{ product: '2 skids', lineClass: 'COMMENT' }]), null);
  });
});

describe('QA bug 4: the unit written onto the size', () => {
  it('2608-712599: "Agg Fine Sand YrdBlk 1CY" is sold by the cubic yard', () => {
    assert.equal(inferUnitFromDescription('Agg Fine Sand YrdBlk 1CY'), 'CY');
    assert.equal(inferUnitFromDescription('Agg 3/4" Clear YrdBlk 1HCY'), 'HCY');
    assert.equal(inferUnitFromDescription('Agg Fine Sand PitBlk 1MT'), 'MT');
  });

  it('still reads nothing into ordinary words', () => {
    assert.equal(inferUnitFromDescription('Fancy Mulch'), 'EA');
    assert.equal(inferUnitFromDescription('Soil Deliv 3.5-6CYScreendUnscrnd'), 'EA');
  });
});

describe("QA bug 5: the supplier's yard", () => {
  it('2608-712595: Unilock under PO 2608-355356 is the Georgetown yard', () => {
    assert.deepEqual(
      awaitingSupplierOf([
        { poNumber: '2608-355356', vendorCode: 'UNILOCKL01', vendorLocation: 'Georgetown', supplierName: 'Unilock Ltd - Ayr' },
        { poNumber: '2608-355356', vendorCode: 'UNILOCKL01', vendorLocation: 'Georgetown', supplierName: 'Unilock Ltd - Ayr' },
      ]),
      [{ supplierName: 'Unilock Ltd - Ayr', location: 'Georgetown', poNumber: '2608-355356' }]
    );
  });
});

describe('QA follow-up: a catch-all code is not one product', () => {
  it('2608-712621: two MISC products stay two, and the MISC fee, skids and comment stay out', () => {
    // The order's six lines, as the Customer Order Summary prints them.
    const view = toDispatchOrder(order([
      { spruceItemNumber: 'COMMENT', product: '**Pickup direct pricing @ Quikrete.**', quantity: new Prisma.Decimal(1), unit: null },
      { spruceItemNumber: 'MISC', product: 'Quikrete Type S Bulk Bag 1362 KG', quantity: new Prisma.Decimal(4), unit: 'EA' },
      { spruceItemNumber: 'MSKID', product: 'Miscellaneous Skid Deposit ($35 refundable upon return in good condition)', quantity: new Prisma.Decimal(4), unit: 'EA' },
      { spruceItemNumber: 'MISC', product: 'Quikrete Spec Mix Corefill Grout Fine 1362 KG Bags', quantity: new Prisma.Decimal(6), unit: 'EA' },
      { spruceItemNumber: 'MSKID', product: 'Miscellaneous Skid Deposit ($35 refundable upon return in good condition)', quantity: new Prisma.Decimal(6), unit: 'EA' },
      { spruceItemNumber: 'MISC', product: 'Energy Surcharge', quantity: new Prisma.Decimal(10), unit: 'EA' },
    ]));
    assert.equal(view.product, 'Quikrete Type S Bulk Bag 1362 KG +1 more');
    assert.deepEqual(view.quantities, [{ quantity: 10, unit: 'EA' }], '4 Type S + 6 Grout; the surcharge is a fee');
    assert.deepEqual(view.lines.map(line => `${line.quantity} ${line.product}`), [
      '4 Quikrete Type S Bulk Bag 1362 KG',
      '6 Quikrete Spec Mix Corefill Grout Fine 1362 KG Bags',
    ]);
  });

  it('is the same product only when code and description both match, ignoring case and spacing', () => {
    assert.equal(sameProductKey({ spruceItemNumber: 'AGG01', product: 'Agg "B" Type 1 PitBlk (MT)' }),
      sameProductKey({ spruceItemNumber: 'agg01', product: '  Agg  "B" Type 1\nPitBlk (MT) ' }));
    assert.notEqual(sameProductKey({ spruceItemNumber: 'MISC', product: 'Quikrete Type S Bulk Bag 1362 KG' }),
      sameProductKey({ spruceItemNumber: 'MISC', product: 'Quikrete Spec Mix Corefill Grout Fine 1362 KG Bags' }));
  });
});

describe('QA bug 7: repeated loads are one product', () => {
  it('2608-712556: six 40 MT loads of AGG01 are one product of 240 MT', () => {
    const load = { spruceItemNumber: 'AGG01', product: 'Agg "B" Type 1 PitBlk (MT)', quantity: new Prisma.Decimal(40), unit: 'MT' };
    const view = toDispatchOrder(order([load, load, load, load, load, load]));
    assert.equal(view.product, 'Agg "B" Type 1 PitBlk (MT)');
    assert.deepEqual(view.quantities, [{ quantity: 240, unit: 'MT' }]);
  });
});

describe('QA gaps: what the flags say', () => {
  const delivering = {
    deliveryDate: day('2026-10-13'),
    shippingAddress: '1 Example St, Cambridge',
    deliveryInstructions: null,
    lines: [],
  };

  it('says the order is missing from the Item Tracking export when that is why it has no address', () => {
    assert.deepEqual(stateFlags({ ...delivering, shippingAddress: null, inItemTracking: false }, false), ['NOT_IN_ITEM_TRACKING']);
    assert.deepEqual(stateFlags({ ...delivering, shippingAddress: null, inItemTracking: true }, false), ['NO_ADDRESS']);
  });

  it('flags a delivery with no phone, never a pickup, and not where the phone is unknown', () => {
    assert.deepEqual(stateFlags({ ...delivering, phone: null }, false), ['NO_PHONE']);
    assert.deepEqual(stateFlags({ ...delivering, phone: '519-555-0100' }, false), []);
    assert.deepEqual(stateFlags({ ...delivering, phone: null }, true), []);
    assert.deepEqual(stateFlags(delivering, false), []);
  });

  it('flags 2608-712595: delivery dated 17/08 on an order entered 13/10', () => {
    assert.deepEqual(
      stateFlags({ ...delivering, deliveryDate: day('2026-08-17'), orderDate: day('2026-10-13') }, false),
      ['DELIVERY_BEFORE_ENTRY']
    );
    assert.deepEqual(stateFlags({ ...delivering, orderDate: day('2026-10-13') }, false), []);
  });
});
