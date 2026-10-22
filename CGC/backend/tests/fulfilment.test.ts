import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyFulfilment, type FulfilmentInput, type FulfilmentLine } from '../src/modules/dispatch/fulfilment.js';

/**
 * The five fulfilment types, as the manager's spec of 22/10/2026 lays them
 * out, on the strings the Oct 21, 2026 reports print. Each test names its order.
 */

const line = (fields: Partial<FulfilmentLine>): FulfilmentLine => ({
  itemCode: 'ITEM',
  description: 'Product',
  lineClass: null,
  poNumber: null,
  vendorCode: null,
  vendorLocation: null,
  supplierName: null,
  supplierAddress: null,
  ...fields,
});

const order = (fields: Partial<FulfilmentInput>): FulfilmentInput => ({
  isPickup: true,
  shippingAddress: null,
  deliveryInstructions: null,
  orderNotes: null,
  deliveryFlag: null,
  sourceReports: ['ITEM_TRACKING', 'ORDER_SUMMARY'],
  lines: [],
  ...fields,
});

/** On the Deliveries report and marked SCH: a CGC truck carries it. */
const scheduled = { isPickup: false, deliveryFlag: 'SCH', sourceReports: ['ITEM_TRACKING', 'ORDER_SUMMARY', 'DELIVERY'] };

describe('supplier direct ship (D1, D2)', () => {
  it('2610-721522: "Unilock Direct Delivery" — Unilock delivers, no PO yet, not in the Order report', () => {
    const result = classifyFulfilment(order({
      isPickup: false,
      shippingAddress: '6888 Drummond Rd,,Niagar',
      sourceReports: ['ITEM_TRACKING'],
      lines: [
        line({ itemCode: 'COMMENT', description: 'Requested: Wall 1) 54m x 0.40m' }),
        line({ itemCode: 'MISCDEL', description: 'Unilock Direct Delivery' }),
        line({ itemCode: 'SSSM375STD', description: 'Siena Stone Smooth 375 Standard' }),
        line({ itemCode: 'USKID', description: 'Unilock Skid Deposit' }),
      ],
    }));
    assert.equal(result.type, 'supplier_direct_ship');
    assert.equal(result.places[0]?.name, 'Unilock');
    assert.deepEqual(result.checks, ['NO_SUPPLIER_PO_YET', 'NOT_IN_ORDER_REPORT']);
    assert.deepEqual(result.signal, { id: 'D1', text: 'Unilock Direct Delivery' });
  });

  it('matches "Unilock DIRECT Delivery Charge" (an earlier test file), and other suppliers in any case', () => {
    for (const [text, supplier] of [
      ['Unilock DIRECT Delivery Charge', 'Unilock'],
      ['PERMACON direct delivery', 'Permacon'],
      ['Bestway Direct Delivered', 'Bestway'],
    ]) {
      const result = classifyFulfilment(order({ lines: [line({ itemCode: 'MISCDEL', description: text })] }));
      assert.equal(result.type, 'supplier_direct_ship', text);
      assert.equal(result.places[0]?.name, supplier, text);
    }
  });

  it('reads "Drop Ship" and "Ship Direct" as direct, the supplier from the order\'s vendor', () => {
    const result = classifyFulfilment(order({
      orderNotes: 'Drop ship to site',
      lines: [line({ itemCode: 'P90', description: 'Paver', poNumber: '2610-300001', vendorCode: 'RINOX01', supplierName: 'Rinox' })],
    }));
    assert.equal(result.type, 'supplier_direct_ship');
    assert.deepEqual(result.places[0], { name: 'Rinox', location: null, address: null, po: '2610-300001' });
  });

  it('never reads CGC\'s own delivery charges as a direct ship', () => {
    for (const text of ['Agg Delivery 1-3CY', 'Flatbed Curbside Delivery', 'Slinger Delivery Standard']) {
      const result = classifyFulfilment(order({ ...scheduled, lines: [line({ itemCode: 'MISCDELD', description: text })] }));
      assert.equal(result.type, 'yard_delivery', text);
    }
  });
});

describe('supplier pickup (P1, P2)', () => {
  it('2610-721461: ship-to "Pickup Direct at Permacon," — collected at Permacon, nothing to check', () => {
    const result = classifyFulfilment(order({
      shippingAddress: 'Pickup Direct at Permacon,',
      lines: [line({ itemCode: 'GW750STDUN' }), line({ itemCode: 'PSKID', description: 'Permacon Skid Deposit' })],
    }));
    assert.equal(result.type, 'external_pickup');
    assert.deepEqual(result.places, [{ name: 'Permacon', location: null, address: null, po: null }]);
    assert.deepEqual(result.checks, []);
  });

  it('2610-721436: "FOB UNILOCK AYR" — collected at Unilock Ayr, not Georgetown, under the order\'s PO', () => {
    const unilock = { poNumber: '2610-357347', vendorCode: 'UNILOCKL01', vendorLocation: 'Georgetown', supplierName: 'Unilock Ltd - Ayr' };
    const result = classifyFulfilment(order({
      shippingAddress: '1654 concession 4 west,Troy',
      lines: [
        line({ itemCode: 'BHS6CSR', description: 'BeaconHill Smooth 60mm Midnight', ...unilock }),
        line({ itemCode: 'COMMENT', description: 'FOB UNILOCK AYR', ...unilock }),
        line({ itemCode: 'USKID', description: 'Unilock Skid Deposit', ...unilock }),
      ],
    }));
    assert.equal(result.type, 'external_pickup');
    assert.deepEqual(result.places, [{ name: 'Unilock', location: 'Ayr', address: null, po: '2610-357347' }]);
    assert.deepEqual(result.signal, { id: 'P2', text: 'FOB UNILOCK AYR' });
  });

  it('takes a multi-word supplier up to the comma: "Pickup at Bestway Stone,"', () => {
    const result = classifyFulfilment(order({ shippingAddress: 'Pickup at Bestway Stone,' }));
    assert.equal(result.places[0]?.name, 'Bestway Stone');
  });

  it('keeps 2608-712621\'s "Pickup direct pricing @ Quikrete" comment working', () => {
    const result = classifyFulfilment(order({
      lines: [line({ itemCode: 'COMMENT', description: '**Pickup direct pricing @ Quikrete.**' })],
    }));
    assert.equal(result.type, 'external_pickup');
    assert.equal(result.places[0]?.name, 'Quikrete');
  });

  it('is CGC\'s own yard for a bare "Pickup", "Pick up at yard", and FOB CGC, Cambridge or yard', () => {
    for (const shippingAddress of ['Pickup,', 'Pick up at yard', 'Pickup @ CGC Yard,']) {
      assert.equal(classifyFulfilment(order({ shippingAddress })).type, 'yard_pickup', shippingAddress);
    }
    for (const text of ['FOB CGC', 'FOB CAMBRIDGE', 'FOB YARD']) {
      assert.equal(classifyFulfilment(order({ lines: [line({ itemCode: 'COMMENT', description: text })] })).type, 'yard_pickup', text);
    }
  });

  it('keeps the external type but asks staff when a CGC truck also seems to carry it', () => {
    const result = classifyFulfilment(order({ ...scheduled, shippingAddress: 'Pickup Direct at Permacon,' }));
    assert.equal(result.type, 'external_pickup');
    assert.deepEqual(result.checks, ['ON_CGC_DELIVERY_SCHEDULE']);
  });

  it('is a direct ship, noted, when both a direct and a pickup signal are there', () => {
    const result = classifyFulfilment(order({
      shippingAddress: 'Pickup at Unilock,',
      lines: [line({ itemCode: 'MISCDEL', description: 'Unilock Direct Delivery' })],
    }));
    assert.equal(result.type, 'supplier_direct_ship');
    assert.ok(result.checks.includes('PICKUP_AND_DIRECT_BOTH_NOTED'), 'both noted');
  });
});

describe('delivery via a supplier or pit (Y1 + H1)', () => {
  it('2610-721443: a CGC truck collects at Willson, Cambridge, under PO 2610-357348', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      shippingAddress: '1565 Bishop St N,,Cambridg',
      lines: [line({ itemCode: 'AGG06', description: 'Recycled Asphalt (MT)', poNumber: '2610-357348', vendorCode: 'WILLSON', vendorLocation: 'Cambridge' })],
    }));
    assert.equal(result.type, 'supplier_haul_delivery');
    assert.deepEqual(result.places, [{ name: 'Willson', location: 'Cambridge', address: null, po: '2610-357348' }]);
    assert.deepEqual(result.checks, []);
  });

  it('2610-721425: an unmapped vendor is shown as its code, never a guessed name', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [line({ itemCode: 'AGG3/4C', description: '3/4" Clear PitBlk (MT)', poNumber: '2610-357344', vendorCode: 'GALTGRAV01' })],
    }));
    assert.deepEqual(result.places[0], { name: 'GALTGRAV01', location: null, address: null, po: '2610-357344' });
  });

  it('2610-721420: "A-Gravel PitBlk (MT)" with no PO — a pit nobody named', () => {
    const result = classifyFulfilment(order({ ...scheduled, lines: [line({ itemCode: 'AGGAGRAVELC', description: 'A-Gravel PitBlk (MT)' })] }));
    assert.equal(result.type, 'supplier_haul_delivery');
    assert.deepEqual(result.places, [{ name: null, location: null, address: null, po: null }]);
    assert.deepEqual(result.checks, ['NO_SUPPLIER_PO', 'SUPPLIER_NOT_NAMED']);
  });

  it('asks to check the pickup point for yard stock bought on a supplier PO', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [line({ itemCode: 'AGG3/4A', description: 'Agg 3/4" Clear YrdBlk 1CY', poNumber: '2610-300002', vendorCode: 'GALTGRAV01' })],
    }));
    assert.deepEqual(result.checks, ['CHECK_PICKUP_POINT']);
  });

  it('ignores a vendor on skid deposit or comment lines only', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [
        line({ itemCode: 'SOILGRDNA', description: 'Garden Soil Bulk' }),
        line({ itemCode: 'USKID', description: 'Unilock Skid Deposit', poNumber: '2610-300003', vendorCode: 'UNILOCKL01' }),
      ],
    }));
    assert.equal(result.type, 'yard_delivery');
  });
});

describe('the yard', () => {
  it('2610-721448: yard stock on a scheduled delivery is a plain delivery', () => {
    const result = classifyFulfilment(order({ ...scheduled, lines: [line({ itemCode: 'AGG3/4A', description: 'Agg 3/4" Clear YrdBlk 1CY' })] }));
    assert.equal(result.type, 'yard_delivery');
  });

  it('2610-721465 and 721526: a supplier\'s product and skid deposit alone are a yard pickup', () => {
    const result = classifyFulfilment(order({
      lines: [line({ itemCode: 'GW375STDUN', description: 'Grande Wall 375 Std Unit Natural' }), line({ itemCode: 'PSKID', description: 'Permacon Skid Deposit' })],
    }));
    assert.equal(result.type, 'yard_pickup');
  });

  it('2610-721442: CGC\'s slinger charge on an undated order is a CGC delivery, not a pickup', () => {
    const result = classifyFulfilment(order({
      lines: [line({ itemCode: 'SOILSCRNA', description: 'Screened Soil Bulk' }), line({ itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' })],
    }));
    assert.equal(result.type, 'yard_delivery');
    assert.deepEqual(result.checks, ['CHECK_DELIVERY_OR_PICKUP'], 'staff confirm it is not a pickup');
  });

  it('asks nothing of a delivery on the Deliveries report, charge or not', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [line({ itemCode: 'SOILSCRNA', description: 'Screened Soil Bulk' }), line({ itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' })],
    }));
    assert.deepEqual(result.checks, []);
  });
});
