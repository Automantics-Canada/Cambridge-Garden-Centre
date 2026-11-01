import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyLine, deliveryTypeOf } from '../src/modules/orders/import/lineClass.js';
import {
  batchFlags,
  combineFlags,
  derivePickup,
  derivedStateFlags,
  isPickupOrder,
  looksIncomplete,
  mergeOrderFacts,
  normalizeAddress,
  stateFlags,
  withFlag,
  type FulfilmentFacts,
  type ReportRows,
} from '../src/modules/orders/import/mergeOrderFacts.js';
import type { ParsedSpruceRow } from '../src/modules/orders/spruce/spruceReportTypes.js';

/** A synthetic report row; every value is invented. */
function row(overrides: Partial<ParsedSpruceRow> = {}): ParsedSpruceRow {
  return {
    documentNumber: '9900-000001',
    customerName: 'Synthetic Customer',
    product: 'Garden Soil Bulk',
    itemNumber: 'SOILGRDNA',
    quantity: 3,
    source: { page: 1, row: 1 },
    ...overrides,
  };
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('mergeOrderFacts', () => {
  it('takes each field from the report that owns it', () => {
    const rows: ReportRows = {
      ORDER_SUMMARY: [row({
        customerName: 'Pat Example',
        accountCode: 'CASH',
        cashier: 'TESTER',
        spruceStatus: 'Open',
        deliveryFlag: 'SCH',
        totalWithTax: 575.08,
        remaining: 508.92,
        grossMarginPct: 45.8,
        orderDateRaw: '09/02/26',
        deliveryDateRaw: '09/02/26',
      })],
      DELIVERY: [row({
        customerName: 'Pat Example',
        accountCode: 'CASH',
        accountName: 'Cash Sales',
        phone: '519-555-0100',
        route: 'NORTH',
        spruceStatus: 'Sched',
        totalWithTax: 575.08,
        deliveryDateRaw: '09/02/26',
      })],
      ITEM_TRACKING: [row({
        customerName: 'Cash Sales',
        orderDateRaw: '9/2/2026',
        deliveryDateRaw: '9/2/2026',
        shippingAddress: '64 Example St,Kitchener',
        deliveryInstructions: 'CUSTOMER ON SITE TO DIRECT DELIVERY',
      })],
    };

    const patch = mergeOrderFacts(rows);

    assert.equal(patch.customerName, 'Pat Example', 'never the item tracking report\'s "Cash Sales"');
    assert.equal(patch.accountName, 'Cash Sales');
    assert.equal(patch.phone, '519-555-0100');
    assert.equal(patch.route, 'NORTH');
    assert.equal(patch.cashier, 'TESTER');
    assert.equal(patch.spruceStatus, 'Open', 'the order summary\'s status before the delivery report\'s');
    assert.equal(patch.deliveryFlag, 'SCH');
    assert.equal(patch.totalWithTax, 575.08);
    assert.equal(patch.remaining, 508.92);
    assert.equal(patch.shippingAddress, '64 Example St,Kitchener');
    assert.equal(patch.deliveryInstructions, 'CUSTOMER ON SITE TO DIRECT DELIVERY');
    assert.deepEqual(patch.orderDate, day('2026-09-02'));
    assert.deepEqual(patch.deliveryDate, day('2026-09-02'));
  });

  it('believes the delivery report about the delivery date when the reports disagree', () => {
    const patch = mergeOrderFacts({
      ORDER_SUMMARY: [row({ orderDateRaw: '09/01/26', deliveryDateRaw: '09/05/26' })],
      DELIVERY: [row({ deliveryDateRaw: '09/03/26' })],
      ITEM_TRACKING: [row({ deliveryDateRaw: '9/4/2026' })],
    });

    assert.deepEqual(patch.deliveryDate, day('2026-09-03'));
  });

  it('never names the customer from the item tracking report alone', () => {
    const patch = mergeOrderFacts({ ITEM_TRACKING: [row({ customerName: 'Cash Sales', orderDateRaw: '9/2/2026' })] });

    assert.equal(patch.customerName, undefined);
  });

  it('sets nothing a present report left blank, so a stored value survives', () => {
    const patch = mergeOrderFacts({ DELIVERY: [row({ deliveryDateRaw: '09/02/26' })] });

    for (const key of ['shippingAddress', 'phone', 'totalWithTax', 'orderDate', 'cashier'] as const) {
      assert.equal(key in patch, false, `${key} must stay unset`);
    }
  });
});

describe('line classification', () => {
  it('names each kind of line by its item code', () => {
    assert.equal(classifyLine('AGG3/4C', '3/4" Clear PitBlk (MT)'), 'PRODUCT');
    assert.equal(classifyLine('MISCDELG', 'Slinger Spreading Aggregates per MT'), 'DELIVERY_CHARGE');
    assert.equal(classifyLine('SOILYELSU3.5-6', 'Soil Deliv 3.5-6CY'), 'DELIVERY_CHARGE');
    assert.equal(classifyLine('USKID', 'Unilock Skid Deposit'), 'DEPOSIT');
    assert.equal(classifyLine('RETURNCOMM', 'CGC Stocked Interlock'), 'COMMENT');
    assert.equal(classifyLine('SALTCOMM', 'Payment The above price per tonne is based on payment by:'), 'COMMENT');
    assert.equal(classifyLine('MISC', 'Energy Surcharge'), 'SURCHARGE');
  });

  it('reads the delivery type off the delivery charge, specialist services first', () => {
    assert.equal(deliveryTypeOf([{ itemCode: 'AGG3/4C' }, { itemCode: 'MISCDELG' }]), 'SLINGER');
    assert.equal(deliveryTypeOf([{ itemCode: 'MISCDELI' }]), 'SPLITBOX');
    assert.equal(deliveryTypeOf([{ itemCode: 'MISCDELD' }]), 'FLATBED');
    assert.equal(deliveryTypeOf([{ itemCode: 'MULCHYEL1-19' }]), 'DUMP');
    assert.equal(deliveryTypeOf([{ itemCode: 'SOILGRDND', description: 'Soil Garden 1CY (Lge Bag) DEL' }]), 'BAG');
    assert.equal(deliveryTypeOf([{ itemCode: 'MISCDEL' }]), 'GENERAL');
    assert.equal(deliveryTypeOf([{ itemCode: 'AGG01' }]), null, 'no charge line says nothing about how');
  });

  it('reads an unlisted delivery charge by its description: 721442\'s MISCDELE slinger, a tri-axle', () => {
    assert.equal(deliveryTypeOf([{ itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' }]), 'SLINGER');
    for (const description of ['Tri-Axle Delivery', 'Triaxle delivery 1-3', 'TRI AXLE Load']) {
      assert.equal(deliveryTypeOf([{ itemCode: 'MISCDELT', description }]), 'DUMP', description);
    }
    assert.equal(deliveryTypeOf([{ itemCode: 'MISCDELX', description: 'Delivery Charge' }]), 'GENERAL', 'still a delivery');
    // A listed code still says it, whatever its description.
    assert.equal(deliveryTypeOf([{ itemCode: 'MISCDELD', description: 'Slinger? no, flatbed' }]), 'FLATBED');
  });
});

describe('addresses', () => {
  it('tidies Spruce\'s stray commas without inventing anything', () => {
    assert.equal(normalizeAddress('90 Example Dr,,Kitchener'), '90 Example Dr, Kitchener');
    assert.equal(normalizeAddress('110 Example St.N.,'), '110 Example St.N.');
    assert.equal(normalizeAddress('  ,  '), null);
    assert.equal(normalizeAddress(undefined), null);
  });

  it('marks an address a driver could not navigate to as written', () => {
    assert.equal(looksIncomplete('Riverside Project'), true, 'no house number');
    assert.equal(looksIncomplete('110 Example St.N.'), true, 'no town');
    assert.equal(looksIncomplete('271 Example St, Cambridge'), false);
  });
});

describe('pickups', () => {
  const lines = (...codes: string[]) => codes.map(itemCode => ({ itemCode }));
  const base = { deliveryDate: null, shippingAddress: '1 Example St, Cambridge', deliveryInstructions: null };

  it('is never a pickup once it has a delivery date', () => {
    assert.equal(isPickupOrder({ ...base, deliveryDate: day('2026-09-02'), lines: lines('AGG01') }), false);
  });

  it('is a pickup when the address, a comment or the absence of any delivery charge says so', () => {
    assert.equal(isPickupOrder({ ...base, shippingAddress: 'Pickup @ Yard,', lines: lines('SOILGRDNA') }), true);
    assert.equal(
      isPickupOrder({ ...base, lines: [{ itemCode: 'COMMENT', description: '**Pickup direct pricing**' }, { itemCode: 'SOILGRDNA' }] }),
      true
    );
    assert.equal(isPickupOrder({ ...base, lines: lines('SOILGRDNA') }), true);
  });

  // The client (Oct 2026): "any order with a delivery charge on the line items
  // can be treated as a delivery." Before, an unlisted code (721442's MISCDELE,
  // 721493's tri-axle) left the order a pickup, and pickup wording beside a
  // charge made it one; both asked staff to confirm instead.
  it('is a delivery whenever CGC charges for one, whatever the code or the address says', () => {
    assert.equal(isPickupOrder({ ...base, lines: lines('SOILGRDNA', 'SOILYELG1-5') }), false);
    assert.equal(isPickupOrder({ ...base, lines: [{ itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' }] }), false);
    assert.equal(isPickupOrder({ ...base, lines: [{ itemCode: 'MISCDELT', description: 'Tri-axle Delivery' }] }), false);
    assert.equal(isPickupOrder({ ...base, shippingAddress: 'Pickup @ Yard,', lines: lines('MISCDEL') }), false);
  });

  it('does not count a supplier\'s "Direct Delivery" line as CGC\'s charge', () => {
    assert.equal(
      isPickupOrder({ ...base, shippingAddress: 'Pickup at Unilock,', lines: [{ itemCode: 'MISCDELX', description: 'Unilock Direct Delivery' }] }),
      true
    );
  });
});

describe('flags', () => {
  const delivering = {
    deliveryDate: day('2026-09-02'),
    shippingAddress: '271 Example St,Cambridge',
    deliveryInstructions: null as string | null,
    lines: [] as Array<{ poNumber?: string | null }>,
  };

  it('flags a delivery with no address, or one to check', () => {
    assert.deepEqual(stateFlags({ ...delivering, shippingAddress: null }, false), ['NO_ADDRESS']);
    assert.deepEqual(stateFlags({ ...delivering, shippingAddress: 'Riverside Project,' }, false), ['CHECK_ADDRESS']);
    assert.deepEqual(stateFlags(delivering, false), []);
  });

  it('does not ask for an address on a pickup or an unscheduled order', () => {
    assert.deepEqual(stateFlags({ ...delivering, shippingAddress: null }, true), []);
    assert.deepEqual(stateFlags({ ...delivering, deliveryDate: null, shippingAddress: null }, false), []);
  });

  it('reads truck limits and an on-site customer from the instructions', () => {
    const flags = stateFlags({
      ...delivering,
      deliveryInstructions: 'MUST SEND A SMALL TRUCK, THERE ARE CABLES. CUSTOMER ON SITE',
    }, false);
    assert.deepEqual(flags, ['SMALL_TRUCK', 'CUSTOMER_ON_SITE']);
    assert.deepEqual(stateFlags({ ...delivering, deliveryInstructions: 'FOLLOW THE DRIVEWAY BELOW' }, false), []);
  });

  it('marks an order waiting on a supplier PO, delivery or not', () => {
    assert.deepEqual(stateFlags({ ...delivering, deliveryDate: null, lines: [{ poNumber: '2608-300001' }] }, true), [
      'AWAITING_SUPPLIER',
    ]);
  });

  const context = { reports: new Set(['ORDER_SUMMARY', 'DELIVERY', 'ITEM_TRACKING'] as const) };

  it('flags reports that disagree on the total or the delivery date', () => {
    const { flags, decided } = batchFlags({
      ORDER_SUMMARY: [row({ totalWithTax: 193.51, remaining: 171.25, unitPrice: 57.0833, quantity: 3, deliveryDateRaw: '09/02/26' })],
      DELIVERY: [row({ totalWithTax: 286.17, deliveryDateRaw: '09/03/26' })],
    }, context);

    assert.ok(flags.includes('TOTAL_MISMATCH'));
    assert.ok(flags.includes('DATE_MISMATCH'));
    assert.ok(decided.includes('TOTAL_MISMATCH') && decided.includes('DATE_MISMATCH'));
  });

  it('checks the order summary\'s lines add up to its subtotal, within two dollars', () => {
    const summary = (unitPrice: number) => ({
      ORDER_SUMMARY: [
        row({ quantity: 1, unitPrice: 38.5, remaining: 171.25 }),
        row({ quantity: 1, unitPrice: 19.25, remaining: 171.25 }),
        row({ quantity: 1, unitPrice, remaining: 171.25 }),
      ],
    });

    assert.ok(!batchFlags(summary(113.5), context).flags.includes('EXTRACTION_CHECK_FAILED'));
    assert.ok(!batchFlags(summary(115), context).flags.includes('EXTRACTION_CHECK_FAILED'), '$1.50 off is within');
    assert.ok(batchFlags(summary(1135), context).flags.includes('EXTRACTION_CHECK_FAILED'));
  });

  it('allows for the cent rounding of unit prices on large quantities', () => {
    // 734.37 square feet at a printed $5.97 that Spruce holds as $5.9663:
    // $4.62 apart with every figure read correctly.
    const pavers = { ORDER_SUMMARY: [row({ quantity: 734.37, unitPrice: 5.97, remaining: 4379.59 })] };

    assert.ok(!batchFlags(pavers, context).flags.includes('EXTRACTION_CHECK_FAILED'));
  });

  it("checks a paid order's lines against its total with tax, since nothing remains", () => {
    // 2610-721467 on 21/10/2026: paid in full, $1,425.98 with tax.
    const paid = (unitPrice: number) => ({
      ORDER_SUMMARY: [
        row({ quantity: 242.34, unitPrice: 3.81, remaining: 0, totalWithTax: 1425.98 }),
        row({ quantity: 2, unitPrice: 40, remaining: 0, totalWithTax: 1425.98 }),
        row({ quantity: 34.77, unitPrice: 3.82, remaining: 0, totalWithTax: 1425.98 }),
        row({ quantity: 1, unitPrice: 40, remaining: 0, totalWithTax: 1425.98 }),
        row({ quantity: 4, unitPrice, remaining: 0, totalWithTax: 1425.98 }),
      ],
    });

    assert.ok(!batchFlags(paid(21.32), context).flags.includes('EXTRACTION_CHECK_FAILED'));
    assert.ok(batchFlags(paid(213.2), context).flags.includes('EXTRACTION_CHECK_FAILED'), 'a misread price still shows');
  });

  it('marks an order entered inside the order summary\'s range but left off it as no longer open', () => {
    const range = { from: day('2026-09-02'), to: day('2026-09-02') };
    const itemOnly = { ITEM_TRACKING: [row({ orderDateRaw: '9/2/2026' })] };

    assert.deepEqual(batchFlags(itemOnly, { ...context, orderSummaryRange: range }).flags, ['NOT_OPEN']);
    // Entered before the range: the order summary was never going to list it.
    const earlier = { ITEM_TRACKING: [row({ orderDateRaw: '8/20/2026' })] };
    assert.deepEqual(batchFlags(earlier, { ...context, orderSummaryRange: range }).flags, []);
  });

  it('keeps what an earlier upload decided only where this one could not judge', () => {
    const stored = ['TOTAL_MISMATCH', 'NOT_IN_LATEST_REPORT', 'NO_ADDRESS', 'SOMETHING_RETIRED'];

    // This upload could judge the total, and the address is always recomputed.
    assert.deepEqual(combineFlags(stored, ['TOTAL_MISMATCH'], []), ['NOT_IN_LATEST_REPORT']);
    assert.deepEqual(combineFlags(stored, ['NOT_IN_LATEST_REPORT'], ['CHECK_ADDRESS']), ['CHECK_ADDRESS', 'TOTAL_MISMATCH']);
  });

  it('adds a flag to an order nothing new is known about without dropping the others', () => {
    assert.deepEqual(withFlag(['NO_ADDRESS', 'SMALL_TRUCK'], 'NOT_IN_LATEST_REPORT'), [
      'NO_ADDRESS',
      'SMALL_TRUCK',
      'NOT_IN_LATEST_REPORT',
    ]);
  });
});

describe('quotations and orders no longer open (Q3, Q7)', () => {
  const reports = new Set(['ORDER_SUMMARY', 'DELIVERY', 'ITEM_TRACKING'] as const);
  const range = { from: day('2026-09-02'), to: day('2026-09-02') };
  const context = { reports, orderSummaryRange: range };
  const itemOnly = (overrides: Partial<ParsedSpruceRow> = {}) => ({
    ITEM_TRACKING: [row({ documentNumber: '9900-000009', orderDateRaw: '9/2/2026', ...overrides })],
  });
  const fresh = { sourceReports: [], hasPo: false, hasActivity: false };

  it('takes a document only Item Tracking lists, entered in range, with no history, for a quotation', () => {
    const result = batchFlags(itemOnly(), context, fresh);
    assert.deepEqual(result.flags, ['QUOTE']);
    assert.ok(result.decided.includes('QUOTE') && result.decided.includes('NOT_OPEN'));
  });

  it('takes it for an order closed since once anything says it was an order', () => {
    assert.deepEqual(batchFlags(itemOnly(), context, { ...fresh, sourceReports: ['ITEM_TRACKING', 'ORDER_SUMMARY'] }).flags, ['NOT_OPEN']);
    assert.deepEqual(batchFlags(itemOnly(), context, { ...fresh, sourceReports: ['DELIVERY'] }).flags, ['NOT_OPEN']);
    assert.deepEqual(batchFlags(itemOnly(), context, { ...fresh, hasPo: true }).flags, ['NOT_OPEN']);
    assert.deepEqual(batchFlags(itemOnly({ poNumber: '9900-300001' }), context, fresh).flags, ['NOT_OPEN'], 'a PO in this upload');
    assert.deepEqual(batchFlags(itemOnly(), context, { ...fresh, hasActivity: true }).flags, ['NOT_OPEN'], 'a stop, driver, invoice or ticket');
    assert.deepEqual(batchFlags(itemOnly(), context).flags, ['NOT_OPEN'], 'no history known: never a guess at a quotation');
  });

  it('decides nothing for a document entered before the range, so an earlier conclusion stands', () => {
    const earlier = batchFlags(itemOnly({ orderDateRaw: '8/20/2026' }), context, fresh);
    assert.deepEqual(earlier, { flags: [], decided: [] });
    assert.deepEqual(combineFlags(['QUOTE'], earlier.decided, earlier.flags), ['QUOTE']);
    assert.deepEqual(combineFlags(['NOT_OPEN'], earlier.decided, earlier.flags), ['NOT_OPEN']);
  });

  it('clears both on a document the order summary or delivery report lists: a quotation converted comes back', () => {
    for (const rows of [
      { ...itemOnly(), ORDER_SUMMARY: [row({ documentNumber: '9900-000009' })] },
      { ...itemOnly(), DELIVERY: [row({ documentNumber: '9900-000009' })] },
    ]) {
      const result = batchFlags(rows, context, fresh);
      assert.ok(!result.flags.includes('QUOTE') && !result.flags.includes('NOT_OPEN'));
      const after = combineFlags(['QUOTE', 'NOT_OPEN'], result.decided, result.flags);
      assert.ok(!after.includes('QUOTE') && !after.includes('NOT_OPEN'));
    }
    // The delivery report alone is enough: a scheduled order is open.
    const deliveryOnly = batchFlags({ DELIVERY: [row()] }, { reports: new Set(['DELIVERY'] as const) }, fresh);
    assert.deepEqual(combineFlags(['NOT_OPEN'], deliveryOnly.decided, deliveryOnly.flags), []);
  });

  it('counts a document named on an unreadable order summary line as on the report', () => {
    const result = batchFlags(itemOnly(), { ...context, mentioned: new Set(['9900-000009']) }, fresh);
    assert.deepEqual(result.flags, []);
    assert.ok(result.decided.includes('QUOTE'));
  });

  it('decides nothing about a document only Item Tracking lists when the order summary is missing or undated', () => {
    assert.deepEqual(batchFlags(itemOnly(), { reports: new Set(['DELIVERY', 'ITEM_TRACKING'] as const) }, fresh).decided, []);
    assert.deepEqual(batchFlags(itemOnly(), { reports }, fresh).decided, []);
  });

  it('falls back on the stored entry date when Item Tracking prints none', () => {
    const result = batchFlags(itemOnly({ orderDateRaw: undefined }), context, { ...fresh, orderDate: day('2026-09-02') });
    assert.deepEqual(result.flags, ['QUOTE']);
  });
});

describe('derivePickup: one rule for the import and for edits', () => {
  // Undated, nothing charged for delivery: a pickup unless closed.
  const collect = { deliveryDate: null, shippingAddress: null, deliveryInstructions: null, lines: [{ itemCode: 'SOILGRDNA', description: 'Garden Soil Bulk' }] };

  it('is a pickup when nothing closes the order', () => {
    assert.equal(derivePickup({ state: collect, flags: { stored: [] } }), true);
  });

  it('is never a pickup while the order is closed or a quotation, whether stored or just decided', () => {
    assert.equal(derivePickup({ state: collect, flags: { stored: ['NOT_OPEN'] } }), false);
    assert.equal(derivePickup({ state: collect, flags: { stored: ['QUOTE'] } }), false);
    assert.equal(derivePickup({ state: collect, flags: { stored: [], decided: ['QUOTE', 'NOT_OPEN'], fresh: ['QUOTE'] } }), false);
    // An upload that could not judge keeps what an earlier one decided.
    assert.equal(derivePickup({ state: collect, flags: { stored: ['NOT_OPEN'], decided: ['TOTAL_MISMATCH'], fresh: [] } }), false);
  });

  it('follows the order again once an upload clears the flag', () => {
    assert.equal(derivePickup({ state: collect, flags: { stored: ['QUOTE'], decided: ['QUOTE', 'NOT_OPEN'], fresh: [] } }), true);
  });

  const facts = (fields: Partial<FulfilmentFacts> = {}): FulfilmentFacts => ({
    orderNotes: null, deliveryFlag: null, sourceReports: ['ITEM_TRACKING', 'ORDER_SUMMARY'], override: null, ...fields,
  });
  const fobLines = [{ itemCode: 'BHS6CSR', description: 'Example Paver 60mm' }, { itemCode: 'COMMENT', description: 'FOB UNILOCK AYR' }];

  // The client (Oct 2026): FOB + supplier = the customer collects there.
  it('is a pickup for an FOB order, even dated or charged for delivery, so it stays off the pools', () => {
    const fob = { ...collect, lines: fobLines };
    assert.equal(derivePickup({ state: fob, flags: { stored: [] }, fulfilment: facts() }), true);
    const dated = { ...fob, deliveryDate: day('2026-09-05') };
    assert.equal(derivePickup({ state: dated, flags: { stored: [] }, fulfilment: facts({ sourceReports: ['DELIVERY'] }) }), true);
    const charged = { ...fob, lines: [...fobLines, { itemCode: 'MISCDELD', description: 'Flatbed Curbside Delivery' }] };
    assert.equal(derivePickup({ state: charged, flags: { stored: [] }, fulfilment: facts() }), true);
    // Without the fulfilment facts, as before: the date decides.
    assert.equal(derivePickup({ state: dated, flags: { stored: [] } }), false);
  });

  it('is a delivery when CGC charges for one, an unlisted code included (721442)', () => {
    const charged = { ...collect, lines: [...collect.lines, { itemCode: 'MISCDELE', description: 'Slinger Delivery Standard' }] };
    assert.equal(derivePickup({ state: charged, flags: { stored: [] }, fulfilment: facts() }), false);
  });

  it('follows the type dispatch set, either way, but never reopens a closed order', () => {
    const fob = { ...collect, lines: fobLines };
    assert.equal(derivePickup({ state: fob, flags: { stored: [] }, fulfilment: facts({ override: 'supplier_haul_delivery' }) }), false);
    assert.equal(derivePickup({ state: fob, flags: { stored: [] }, fulfilment: facts({ override: 'yard_delivery' }) }), false);
    const charged = { ...collect, lines: [{ itemCode: 'MISCDEL', description: 'Delivery' }] };
    assert.equal(derivePickup({ state: charged, flags: { stored: [] }, fulfilment: facts({ override: 'yard_pickup' }) }), true);
    assert.equal(derivePickup({ state: charged, flags: { stored: [] }, fulfilment: facts({ override: 'external_pickup' }) }), true);
    assert.equal(derivePickup({ state: collect, flags: { stored: ['QUOTE'] }, fulfilment: facts({ override: 'yard_pickup' }) }), false);
  });

  it('raises no delivery checks on a quotation', () => {
    const dated = { ...collect, deliveryDate: day('2026-09-05'), phone: null, inDeliveryReport: true };
    assert.deepEqual(derivedStateFlags({ state: dated, flags: { stored: ['QUOTE'] } }, false), []);
    assert.deepEqual(derivedStateFlags({ state: dated, flags: { stored: [] } }, false), ['NO_ADDRESS', 'NO_PHONE']);
  });
});
