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

  it('carries the instructions, truck and PO details the driver and the merge need', () => {
    const { rows } = parseItemTrackingReport(itemTrackingReport());
    const instructed = rows.find(r => r.itemNumber === 'BCAM48GG');
    const ordered = rows.find(r => r.itemNumber === 'RETURNCOMM');

    // The double space Spruce joins wrapped lines with is not part of the text.
    assert.equal(instructed?.deliveryInstructions, 'CALL BEFORE ARRIVAL');
    assert.equal(instructed?.deliveryTruck, 'TRI-AXLE');
    assert.equal(ordered?.vendorLocation, 'Brantford');
    assert.equal(ordered?.poValue, 1204.55);
    assert.equal(rows.find(r => r.itemNumber === 'SOILGRDNA')?.deliveryInstructions, undefined);
  });

  it('refuses a stripe whose pages disagree about how many rows there are', () => {
    // Pairing halves of rows that do not line up would hand one order's
    // address or item to another. A gap is noticed; a wrong address is not.
    const [left, middle, right] = itemTrackingReport();
    const missingAnItem = page(1, middle!.runs.filter(r => r.y !== 9.28));

    assert.throws(
      () => parseItemTrackingReport([left!, missingAnItem, right!]),
      (err: unknown) =>
        err instanceof SprucePdfError && err.code === 'ROW_COUNT_MISMATCH' && /4 orders.*3 items/.test(err.message)
    );
  });

  it('refuses a report whose leading columns are missing', () => {
    const onlyBandTwo = [itemTrackingReport()[1]!];

    assert.throws(
      () => parseItemTrackingReport(onlyBandTwo),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'MISSING_HEADERS'
    );
  });

  it('refuses a report whose bands carry headings but no item lines', () => {
    const headersOnly = [
      page(0, [run(1.2, 5.7, 'Document'), run(11.6, 5.7, 'Customer Name')]),
      page(1, [run(10.46, 5.7, 'Item Number'), run(16.09, 5.7, 'Item Desc'), run(29.05, 5.7, 'Qty')]),
    ];

    assert.throws(
      () => parseItemTrackingReport(headersOnly),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'NO_READABLE_ROWS'
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

  it('copies the order row\'s own facts onto each of its lines', () => {
    const { rows } = parseOrderSummaryReport(orderSummaryReport());
    const unscheduled = rows.find(r => r.itemNumber === 'SOILGRDNA');
    const scheduled = rows.find(r => r.itemNumber === 'BST24X24GR');

    assert.equal(unscheduled?.accountCode, 'RIVERBEN01');
    assert.equal(unscheduled?.cashier, 'TESTER');
    assert.equal(unscheduled?.spruceStatus, 'Open');
    assert.equal(unscheduled?.deliveryFlag, undefined);
    assert.equal(unscheduled?.totalWithTax, 118.65);
    assert.equal(unscheduled?.remainingDeposit, 0);
    assert.equal(unscheduled?.remaining, 105);
    assert.equal(unscheduled?.grossMarginPct, 100);

    assert.equal(scheduled?.deliveryFlag, 'SCH');
    assert.equal(scheduled?.totalWithTax, 1250);
    assert.equal(scheduled?.remaining, 1106.19);
    assert.equal(scheduled?.grossMarginPct, 42.1);
  });

  it('reads the order figures when the margin heading drops out of the heading row', () => {
    // On the real report's last page the GM% heading prints a hair below its
    // neighbours and is clustered on its own, leaving no band for the margin.
    // The figures are placed by the percent sign instead, so none shifts.
    const [only] = orderSummaryReport();
    const withoutMarginHeading = page(0, only!.runs.filter(r => !(r.text === 'GM%' && r.y === 6.61)));
    const { rows } = parseOrderSummaryReport([withoutMarginHeading]);
    const soil = rows.find(r => r.itemNumber === 'SOILGRDNA');

    assert.equal(soil?.totalWithTax, 118.65);
    assert.equal(soil?.grossMarginPct, 100);
    assert.equal(soil?.remaining, 105);
  });

  it('reads unit price and unit cost off each line', () => {
    const { rows } = parseOrderSummaryReport(orderSummaryReport());

    assert.equal(rows.find(r => r.itemNumber === 'SOILGRDNA')?.unitPrice, 35);
    assert.equal(rows.find(r => r.itemNumber === 'SOILGRDNA')?.unitCost, 0);
    assert.equal(rows.find(r => r.itemNumber === 'BSKID')?.unitPrice, 40);
    assert.equal(rows.find(r => r.itemNumber === 'BSKID')?.unitCost, 40);
    // Quantities received and sold sit left of the price; neither is read as it.
    assert.equal(rows.find(r => r.itemNumber === 'BST24X24GR')?.unitPrice, undefined);
  });

  it('refuses a report whose order headings sit above no item lines', () => {
    const headersOnly = [page(0, [
      run(1.0, 6.61, 'Order#'),
      run(5.5, 6.61, 'Account'),
      run(8.0, 6.61, 'Name'),
      run(19.3, 6.61, 'Cashier'),
      run(22.1, 6.61, 'Branch'),
    ])];

    assert.throws(
      () => parseOrderSummaryReport(headersOnly),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'NO_READABLE_ROWS'
    );
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
    assert.equal(rows[0]?.accountName, 'Cash Sales');
  });

  it('reads its one date as the delivery date, because the report is filtered on it', () => {
    // Orders keyed weeks earlier print the day they go out here. Read as the
    // order date, it dated them all today and gave none a delivery date.
    const { rows } = parseDeliveryReport(deliveryReport());

    for (const row of rows) {
      assert.equal(row.deliveryDateRaw, '09/02/26');
      assert.equal(row.orderDateRaw, undefined);
    }
  });

  it('reads the account, route, status, phone and total off the order row', () => {
    const { rows } = parseDeliveryReport(deliveryReport());
    const first = rows[0];
    const second = rows.find(row => row.itemNumber === 'AGG01');

    assert.equal(first?.accountCode, 'CASH');
    assert.equal(first?.route, 'NORTH');
    assert.equal(first?.spruceStatus, 'Sched');
    assert.equal(first?.phone, '519-555-0128');
    assert.equal(first?.totalWithTax, 176.28);

    // A row without type and status gives no route to guess at.
    assert.equal(second?.route, undefined);
    assert.equal(second?.accountCode, undefined);
    assert.equal(second?.totalWithTax, 2149.57);
  });

  it('keeps a phone extension that wraps onto the line below, and a bracketed area code', () => {
    const { rows } = parseDeliveryReport([page(0, [
      run(1.5, 5.53, '09/02/26 - 09/02/26 (Inv / Tkt / Ord)    Qty Branch'),
      run(1.5, 8.72, '09/02/26'),
      run(4.2, 8.72, '2608-700010'),
      run(8.2, 8.72, 'Order'),
      run(10.5, 8.72, 'Sched'),
      run(16.4, 8.72, 'GOLFCLUB'),
      run(21.4, 8.72, 'Fairway Golf Club'),
      run(37.1, 8.72, '(519) 555-7719 '),
      run(42.6, 8.72, '485.34'),
      run(16.4, 9.63, '0'),
      run(21.4, 9.63, 'Fairway Golf Club'),
      run(37.1, 9.63, 'EXT.12'),
      run(4.5, 11.38, 'SOILSCRNA'),
      run(12.4, 11.38, 'Screened Soil Bulk'),
      run(28.8, 11.38, '21.0000'),
      run(31.3, 11.38, 'CY'),
    ])]);

    assert.equal(rows[0]?.phone, '(519) 555-7719 EXT.12');
    assert.equal(rows[0]?.customerName, 'Fairway Golf Club');
    assert.equal(rows[0]?.accountCode, 'GOLFCLUB');
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

  it('does not read a phone extension as the customer', () => {
    // The real failure on document 2608-712563: `EXT.1` sat immediately before
    // the phone number and replaced the customer's actual name.
    const pages = [page(0, [
      run(1.5, 5.53, '09/02/26 - 09/02/26 (Inv / Tkt / Ord)    Qty Branch'),
      run(1.5, 8.72, '09/02/26'),
      run(4.2, 8.72, '2608-700009'),
      run(16.4, 8.72, 'CGOLF01'),
      run(21.4, 8.72, 'Cambridge Golf Course'),
      run(30.0, 8.72, 'EXT.1'),
      run(37.1, 8.72, '519-555-0144'),
      run(42.7, 8.72, '88.25'),
      // The line under the order carries only codes; it must not refine.
      run(16.4, 9.63, '0'),
      run(21.4, 9.63, 'EXT.1'),
      run(4.5, 11.38, 'SOILSCRNA'),
      run(12.4, 11.38, 'Screened Soil Bulk'),
      run(29.1, 11.38, '4.0000'),
      run(31.3, 11.38, 'CY'),
    ])];

    const { rows } = parseDeliveryReport(pages);

    assert.equal(rows[0]?.customerName, 'Cambridge Golf Course');
    assert.equal(rows[0]?.phone, '519-555-0144 EXT.1');
  });

  it('refuses a report whose headings sit above no readable item lines', () => {
    assert.throws(
      () => parseDeliveryReport([page(0, [
        run(1.5, 5.53, '09/02/26 - 09/02/26 (Inv / Tkt / Ord)    Qty Branch'),
        run(1.5, 8.72, '09/02/26'),
        run(4.2, 8.72, '2608-700009'),
        run(21.4, 8.72, 'Harrowgate Masonry'),
        run(37.1, 8.72, '519-555-6336'),
        run(42.7, 8.72, '2,149.57'),
      ])]),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'NO_READABLE_ROWS'
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
