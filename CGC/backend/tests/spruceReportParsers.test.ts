import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SprucePdfError } from '../src/lib/pdf/pdfWords.js';
import { detectSpruceReport } from '../src/modules/orders/spruce/detectSpruceReport.js';
import { parseDeliveryReport } from '../src/modules/orders/spruce/parseDeliveryReport.js';
import { parseItemTrackingReport } from '../src/modules/orders/spruce/parseItemTrackingReport.js';
import { parseOrderSummaryReport } from '../src/modules/orders/spruce/parseOrderSummaryReport.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import {
  deliveryReport,
  itemTrackingReport,
  itemTrackingSecondStripe,
  orderSummaryReport,
  page,
  run,
} from './fixtures/spruceLayouts.js';

describe('detectSpruceReport', () => {
  it('names each of the three layouts', () => {
    assert.equal(detectSpruceReport(itemTrackingReport()), 'ITEM_TRACKING');
    assert.equal(detectSpruceReport(orderSummaryReport()), 'ORDER_SUMMARY');
    assert.equal(detectSpruceReport(deliveryReport()), 'DELIVERY');
  });

  it('refuses an unrecognised report rather than guessing at one', () => {
    // Every parser reads by position, so the wrong one would not fail loudly —
    // it would return confident, wrong rows.
    const invoice = [page(0, [run(1, 1, 'Supplier Invoice'), run(1, 2, 'Amount Due')])];

    assert.throws(
      () => detectSpruceReport(invoice),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'UNKNOWN_REPORT'
    );
  });

  it('quotes what it saw, so the message says something actionable', () => {
    try {
      detectSpruceReport([page(0, [run(1, 1, 'Quarterly Stock Valuation')])]);
      assert.fail('expected a SprucePdfError');
    } catch (err) {
      assert.match((err as Error).message, /Quarterly Stock Valuation/);
    }
  });

  it('refuses a PDF with no pages', () => {
    assert.throws(() => detectSpruceReport([]), SprucePdfError);
  });
});

describe('parseItemTrackingReport', () => {
  it('rejoins a row split across the sideways page break', () => {
    // The document number is on page one and its PO on page two. Nothing that
    // reads a page on its own can put these together.
    const { rows } = parseItemTrackingReport(itemTrackingReport());
    const withPo = rows.find(row => row.itemNumber === 'RETURNCOMM');

    assert.equal(withPo?.documentNumber, '2608-700002');
    assert.equal(withPo?.poNumber, '2608-300001');
    assert.equal(withPo?.vendorName, 'STONECO01');
    assert.equal(withPo?.customerName, 'Harrowgate Masonry');
  });

  it('keeps a description that overflows the Qty column out of the quantity', () => {
    const { rows } = parseItemTrackingReport(itemTrackingReport());
    const overflowing = rows.find(row => row.itemNumber === 'RETURNCOMM');

    assert.equal(overflowing?.quantity, 1);
    assert.match(overflowing?.product ?? '', /^Returns accepted in full skids only/);
  });

  it('binds each description to its own item code', () => {
    const { rows } = parseItemTrackingReport(itemTrackingReport());

    assert.equal(rows.find(r => r.itemNumber === 'SOILGRDNA')?.product, 'Garden Soil Bulk');
    assert.equal(rows.find(r => r.itemNumber === 'SOILGRDNA')?.quantity, 3);
  });

  it('carries the shipping address and dates off the first band', () => {
    const { rows } = parseItemTrackingReport(itemTrackingReport());
    const first = rows.find(r => r.itemNumber === 'SOILGRDNA');

    assert.equal(first?.shippingAddress, '14 Mill Race Rd.,');
    assert.equal(first?.orderDateRaw, '9/2/2026');
    assert.equal(rows.find(r => r.itemNumber === 'RETURNCOMM')?.deliveryDateRaw, '9/5/2026');
  });

  it('reads a second stripe of rows after the bands wrap round', () => {
    const { rows, unreadable } = parseItemTrackingReport(itemTrackingSecondStripe());

    assert.deepEqual(unreadable, []);
    const later = rows.find(row => row.documentNumber === '2608-700003');
    assert.equal(later?.product, 'Mulch Cedar 1CY Bulk');
    assert.equal(later?.quantity, 12);
  });

  it('ignores the revision stamp in the footer instead of reporting it', () => {
    const { rows, unreadable } = parseItemTrackingReport(itemTrackingReport());

    assert.deepEqual(unreadable, []);
    assert.ok(!rows.some(row => row.documentNumber.includes('Revision')));
  });

  it('refuses a report whose leading columns are missing', () => {
    const onlyBandTwo = [itemTrackingReport()[1]!];

    assert.throws(
      () => parseItemTrackingReport(onlyBandTwo),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'MISSING_HEADERS'
    );
  });
});

describe('parseOrderSummaryReport', () => {
  it('reads quantity and unit despite the value sitting past the midpoint', () => {
    // QtyOrd is headed at 17.5 and filled at 18.9, with U/M beginning at 19.3.
    const { rows } = parseOrderSummaryReport(orderSummaryReport());
    const soil = rows.find(row => row.itemNumber === 'SOILGRDNA');

    assert.equal(soil?.quantity, 3);
    assert.equal(soil?.unit, 'CY');
  });

  it('appends continuation lines to the item they belong to', () => {
    const { rows } = parseOrderSummaryReport(orderSummaryReport());

    assert.equal(
      rows.find(row => row.itemNumber === 'BSKID')?.product,
      'Bestway Skid Deposit ($35 refundable upon return in good condition)'
    );
  });

  it('does not carry a continuation onto the next item', () => {
    // The failure this replaced: a wrapped description merged into whichever
    // row was judged nearest, describing an item as the one below it.
    const { rows } = parseOrderSummaryReport(orderSummaryReport());

    assert.equal(
      rows.find(row => row.itemNumber === 'BST24X24GR')?.product,
      '24" x 24" Standard Patio Stone Brick Impression'
    );
  });

  it('attributes each item to the order above it', () => {
    const { rows } = parseOrderSummaryReport(orderSummaryReport());

    assert.equal(rows.find(r => r.itemNumber === 'SOILGRDNA')?.documentNumber, '2608-700001');
    assert.equal(rows.find(r => r.itemNumber === 'BSKID')?.documentNumber, '2608-700002');
    assert.equal(rows.find(r => r.itemNumber === 'BSKID')?.customerName, 'Harrowgate Masonry');
  });

  it('separates the order date from the scheduled delivery date', () => {
    const { rows } = parseOrderSummaryReport(orderSummaryReport());
    const scheduled = rows.find(row => row.itemNumber === 'BSKID');

    assert.equal(scheduled?.orderDateRaw, '09/02/26');
    assert.equal(scheduled?.deliveryDateRaw, '09/05/26');
    assert.equal(rows.find(r => r.itemNumber === 'SOILGRDNA')?.deliveryDateRaw, undefined);
  });

  it('reports nothing unreadable for a well-formed report', () => {
    assert.deepEqual(parseOrderSummaryReport(orderSummaryReport()).unreadable, []);
  });
});

describe('parseDeliveryReport', () => {
  it('reads items under the order they follow', () => {
    const { rows, unreadable } = parseDeliveryReport(deliveryReport());

    assert.deepEqual(unreadable, []);
    assert.equal(rows.length, 5);
    assert.equal(rows[0]?.documentNumber, '2608-700001');
    assert.equal(rows[0]?.product, 'Screened Soil Bulk');
    assert.equal(rows[0]?.quantity, 4);
    assert.equal(rows[0]?.unit, 'CY');
  });

  it('prefers the person named under a trade account', () => {
    const { rows } = parseDeliveryReport(deliveryReport());

    assert.equal(rows[0]?.customerName, 'Priya Raman');
  });

  it('joins a wrapped description', () => {
    const { rows } = parseDeliveryReport(deliveryReport());

    assert.equal(
      rows.find(row => row.itemNumber === 'RSKID')?.product,
      'Rinox Skid Deposit ($35 refundable upon return in good condition)'
    );
  });

  it('does not append the next page\'s letterhead to the last description', () => {
    const { rows } = parseDeliveryReport(deliveryReport());

    for (const row of rows) assert.doesNotMatch(row.product, /Branch:|Station:/);
  });

  it('starts a new order on the page after a break', () => {
    const { rows } = parseDeliveryReport(deliveryReport());
    const second = rows.find(row => row.itemNumber === 'AGG01');

    assert.equal(second?.documentNumber, '2608-700002');
    assert.equal(second?.customerName, 'Harrowgate Masonry');
    assert.equal(second?.quantity, 40);
  });

  it('refuses a report with no orders in it', () => {
    assert.throws(
      () => parseDeliveryReport([page(0, [run(1.5, 5.53, '(Inv / Tkt / Ord)')])]),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'MISSING_HEADERS'
    );
  });
});

describe('parseSprucePages', () => {
  it('routes each layout to the parser that reads it', () => {
    assert.equal(parseSprucePages(itemTrackingReport()).type, 'ITEM_TRACKING');
    assert.equal(parseSprucePages(orderSummaryReport()).type, 'ORDER_SUMMARY');
    assert.equal(parseSprucePages(deliveryReport()).type, 'DELIVERY');
  });
});
