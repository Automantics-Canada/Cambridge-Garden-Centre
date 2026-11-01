import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyFulfilment, type FulfilmentInput, type FulfilmentLine } from '../src/modules/dispatch/fulfilment.js';

/**
 * The five fulfilment types, as the manager's spec of 22/10/2026 lays them
 * out, on the strings the Oct 21, 2026 reports print, with the client's
 * answers of Oct 2026 on top. Each test names its order.
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
  deliveryDate: null,
  lines: [],
  ...fields,
});

/** A pit or supplier dispatch chose; invented. */
const pit = { id: 'pit-1', name: 'Example Pit', address: '1 Pit Rd, Exampleville', location: null };

/** On the Deliveries report and marked SCH: a CGC truck carries it. */
const scheduled = { isPickup: false, deliveryFlag: 'SCH', sourceReports: ['ITEM_TRACKING', 'ORDER_SUMMARY', 'DELIVERY'] };

describe('supplier delivery wording (D1, D2): CGC work, noted', () => {
  // The client (Oct 2026): "most often we deliver ourselves or broker our own
  // truck"; a supplier delivery shows as a freight line on the PO, which the
  // app cannot read yet. Wording alone no longer hides an order from dispatch.
  it('2610-721522: "Unilock Direct Delivery" — still CGC work, the wording noted, not in the Order report', () => {
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
    assert.equal(result.type, 'yard_delivery');
    assert.deepEqual(result.checks, ['SUPPLIER_DELIVERY_NOTED', 'NOT_IN_ORDER_REPORT', 'NOT_ON_DELIVERIES_REPORT']);
    assert.deepEqual(result.signal, { id: 'D1', text: 'Unilock Direct Delivery' });
  });

  it('still reads "Unilock DIRECT Delivery Charge" and other suppliers in any case, and never as a direct ship', () => {
    for (const text of ['Unilock DIRECT Delivery Charge', 'PERMACON direct delivery', 'Bestway Direct Delivered', 'Customer wants direct delivery']) {
      const result = classifyFulfilment(order({ lines: [line({ itemCode: 'MISCDEL', description: text })] }));
      assert.equal(result.type, 'yard_delivery', text);
      assert.ok(result.checks.includes('SUPPLIER_DELIVERY_NOTED'), text);
    }
  });

  it('reads "Drop Ship" as noted on what the lines say: here a haul from the PO\'s supplier', () => {
    const result = classifyFulfilment(order({
      orderNotes: 'Drop ship to site',
      lines: [line({ itemCode: 'P90', description: 'Paver', poNumber: '2610-300001', vendorCode: 'RINOX01', supplierName: 'Rinox' })],
    }));
    assert.equal(result.type, 'supplier_haul_delivery');
    assert.deepEqual(result.places, [{ name: 'Rinox', location: null, address: null, po: '2610-300001' }]);
    assert.ok(result.checks.includes('SUPPLIER_DELIVERY_NOTED'));
  });

  it('never reads CGC\'s own delivery charges as supplier wording', () => {
    for (const text of ['Agg Delivery 1-3CY', 'Flatbed Curbside Delivery', 'Slinger Delivery Standard']) {
      const result = classifyFulfilment(order({ ...scheduled, lines: [line({ itemCode: 'MISCDELD', description: text })] }));
      assert.equal(result.type, 'yard_delivery', text);
      assert.deepEqual(result.checks, [], text);
    }
  });

  it('is a direct ship only when dispatch says so, the supplier from the wording', () => {
    const result = classifyFulfilment(order({
      override: 'supplier_direct_ship',
      lines: [line({ itemCode: 'MISCDEL', description: 'Unilock Direct Delivery' }), line({ itemCode: 'SSSM375STD' })],
    }));
    assert.equal(result.type, 'supplier_direct_ship');
    assert.equal(result.places[0]?.name, 'Unilock');
    assert.deepEqual(result.signal, { id: 'STAFF', text: 'Set by dispatch' });
    assert.deepEqual(result.checks, ['NO_SUPPLIER_PO_YET']);
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

  it('is a supplier pickup, noted, when both a direct and a pickup signal are there', () => {
    const result = classifyFulfilment(order({
      shippingAddress: 'Pickup at Unilock,',
      lines: [line({ itemCode: 'MISCDEL', description: 'Unilock Direct Delivery' })],
    }));
    assert.equal(result.type, 'external_pickup');
    assert.deepEqual(result.checks, ['PICKUP_AND_DIRECT_BOTH_NOTED'], 'both noted; the supplier line is not a CGC charge');
  });

  // The client (Oct 2026): FOB + supplier means the customer collects there
  // more than 95% of the time. A CGC charge beside it only raises the question.
  it('keeps an FOB order with a CGC delivery charge a supplier pickup, and asks', () => {
    const result = classifyFulfilment(order({
      lines: [
        line({ itemCode: 'BHS6CSR', description: 'Example Paver 60mm', poNumber: '9900-200001', vendorCode: 'UNILOCKL01' }),
        line({ itemCode: 'COMMENT', description: 'FOB UNILOCK AYR' }),
        line({ itemCode: 'MISCDELD', description: 'Flatbed Curbside Delivery' }),
      ],
    }));
    assert.equal(result.type, 'external_pickup');
    assert.deepEqual(result.places, [{ name: 'Unilock', location: 'Ayr', address: null, po: '9900-200001' }]);
    assert.deepEqual(result.checks, ['ON_CGC_DELIVERY_SCHEDULE']);
  });
});

describe('what dispatch sets on the order', () => {
  const fob = (fields: Partial<FulfilmentInput> = {}) => {
    const unilock = { poNumber: '2610-357347', vendorCode: 'UNILOCKL01', vendorLocation: 'Georgetown', supplierName: 'Unilock Ltd - Ayr' };
    return order({
      shippingAddress: '1654 concession 4 west,Troy',
      lines: [
        line({ itemCode: 'BHS6CSR', description: 'BeaconHill Smooth 60mm Midnight', ...unilock }),
        line({ itemCode: 'COMMENT', description: 'FOB UNILOCK AYR', ...unilock }),
      ],
      ...fields,
    });
  };

  it('721436 sent with a CGC truck after all: collected at the FOB yard, Ayr, under its PO, not Georgetown', () => {
    const result = classifyFulfilment(fob({ override: 'supplier_haul_delivery' }));
    assert.equal(result.type, 'supplier_haul_delivery');
    assert.deepEqual(result.places, [{ name: 'Unilock', location: 'Ayr', address: null, po: '2610-357347' }]);
    assert.deepEqual(result.signal, { id: 'STAFF', text: 'Set by dispatch' });
    assert.deepEqual(result.checks, [], 'no ON_CGC_DELIVERY_SCHEDULE: dispatch has answered it');
  });

  it('sends the haul to the pit dispatch named over the FOB place', () => {
    const result = classifyFulfilment(fob({ override: 'supplier_haul_delivery', pit }));
    assert.deepEqual(result.places, [{ name: 'Example Pit', location: null, address: '1 Pit Rd, Exampleville', po: null }]);
  });

  it('makes any order a pickup or a yard delivery, with no places', () => {
    const delivery = order({ ...scheduled, lines: [line({ itemCode: 'AGG06', poNumber: '9900-200002', vendorCode: 'WILLSON' })] });
    assert.deepEqual(classifyFulfilment({ ...delivery, override: 'yard_pickup' }), {
      type: 'yard_pickup', places: [], signal: { id: 'STAFF', text: 'Set by dispatch' }, checks: [],
    });
    assert.equal(classifyFulfilment({ ...delivery, override: 'yard_delivery' }).type, 'yard_delivery');
    assert.equal(classifyFulfilment(fob({ override: 'external_pickup' })).places[0]?.location, 'Ayr');
  });

  it('ignores a type it does not know', () => {
    assert.equal(classifyFulfilment(fob({ override: 'teleport' })).type, 'external_pickup');
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

  // The client (Oct 2026): a PO attached means CGC picks up at the supplier,
  // whatever the stock is called. There is nothing left to check.
  it('collects yard stock bought on a supplier PO at that supplier, without a question', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [line({ itemCode: 'AGG3/4A', description: 'Agg 3/4" Clear YrdBlk 1CY', poNumber: '2610-300002', vendorCode: 'GALTGRAV01' })],
    }));
    assert.equal(result.type, 'supplier_haul_delivery');
    assert.deepEqual(result.checks, []);
  });

  it('lists every supplier of a multi-PO haul, in line order', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [
        line({ itemCode: 'AGG06', poNumber: '9900-200003', vendorCode: 'EXAMPLEV01', supplierName: 'Example Quarry', vendorLocation: 'North' }),
        line({ itemCode: 'P90', poNumber: '9900-200004', vendorCode: 'SAMPLEV02' }),
        line({ itemCode: 'AGG07', poNumber: '9900-200003', vendorCode: 'EXAMPLEV01', supplierName: 'Example Quarry', vendorLocation: 'North' }),
      ],
    }));
    assert.deepEqual(result.places.map(place => [place.name, place.po]), [
      ['Example Quarry', '9900-200003'],
      ['SAMPLEV02', '9900-200004'],
    ]);
  });

  it('collects goods on a PO linked to a supplier by hand, with no vendor code', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [line({ itemCode: 'AGG06', poNumber: '9900-200005', supplierName: 'Example Quarry' })],
    }));
    assert.equal(result.type, 'supplier_haul_delivery');
    assert.deepEqual(result.places, [{ name: 'Example Quarry', location: null, address: null, po: '9900-200005' }]);
  });

  // The client (Oct 2026): dispatch determines the pit each time.
  it('721420 with the pit dispatch chose: that supplier, its address, no PO, nothing unnamed', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      pit: { ...pit, location: 'Exampleville' },
      lines: [line({ itemCode: 'AGGAGRAVELC', description: 'A-Gravel PitBlk (MT)' })],
    }));
    assert.equal(result.type, 'supplier_haul_delivery');
    assert.deepEqual(result.places, [{ name: 'Example Pit', location: 'Exampleville', address: '1 Pit Rd, Exampleville', po: null }]);
    assert.deepEqual(result.signal, { id: 'H2', text: 'Set by dispatch: Example Pit' });
    assert.deepEqual(result.checks, []);

    // A yard the address on file is not for gets no street, as for a PO's vendor.
    const elsewhere = classifyFulfilment(order({ ...scheduled, pit: { ...pit, location: 'South' }, lines: [] }));
    assert.equal(elsewhere.places[0]?.address, null);
  });

  it('puts the pit dispatch chose over the PO\'s vendor, quoting a PO only when it was raised with that pit', () => {
    const galt = line({ itemCode: 'AGG3/4C', description: '3/4" Clear PitBlk (MT)', poNumber: '2610-357344', vendorCode: 'GALTGRAV01' });
    const other = classifyFulfilment(order({ ...scheduled, pit, lines: [galt] }));
    assert.deepEqual(other.places, [{ name: 'Example Pit', location: null, address: '1 Pit Rd, Exampleville', po: null }]);

    const same = classifyFulfilment(order({ ...scheduled, pit, lines: [{ ...galt, supplierId: 'pit-1' }] }));
    assert.equal(same.places[0]?.po, '2610-357344');
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

  // The client (Oct 2026): any order with a delivery charge is a delivery,
  // and one missing from the Deliveries report was done already.
  it('2610-721442: CGC\'s slinger charge on an undated order is a delivery, likely done already', () => {
    for (const isPickup of [true, false]) {
      const result = classifyFulfilment(order({
        isPickup,
        lines: [line({ itemCode: 'SOILSCRNA', description: 'Screened Soil Bulk' }), line({ itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' })],
      }));
      assert.equal(result.type, 'yard_delivery');
      assert.deepEqual(result.checks, ['NOT_ON_DELIVERIES_REPORT']);
    }
  });

  it('asks nothing of a dated delivery, even one no Deliveries report has listed yet', () => {
    const result = classifyFulfilment(order({
      isPickup: false,
      deliveryDate: new Date('2026-10-23T00:00:00.000Z'),
      lines: [line({ itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' })],
    }));
    assert.deepEqual(result.checks, []);
  });

  it('asks nothing of a delivery on the Deliveries report, charge or not', () => {
    const result = classifyFulfilment(order({
      ...scheduled,
      lines: [line({ itemCode: 'SOILSCRNA', description: 'Screened Soil Bulk' }), line({ itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' })],
    }));
    assert.deepEqual(result.checks, []);
  });
});
