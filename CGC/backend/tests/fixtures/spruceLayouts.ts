import type { PdfTextPage, PdfTextRun } from '../../src/lib/pdf/pdfWords.js';

/**
 * Synthetic Spruce report pages.
 *
 * Coordinates reproduce the real layouts — heading positions, the 0.9 row
 * pitch, and the offsets that make each report awkward — but every name, number
 * and address is invented. Client data is never committed to this repository,
 * and a fixture PDF is not an option in any case: pdf2json rejects PDFs that a
 * test could generate, so parsing is driven from page objects instead.
 */

export function run(x: number, y: number, text: string, fontSize = 13.7): PdfTextRun {
  return { text, x, y, w: text.length * 0.3, fontSize };
}

export function page(pageIndex: number, runs: PdfTextRun[]): PdfTextPage {
  return { pageIndex, width: 49.5, height: 38.25, runs };
}

// ---------------------------------------------------------------- item tracking

const ITEM_TRACKING_BAND_ONE = (y: number) => [
  run(1.2, y, 'Document'),
  run(5.1, y, 'Delivery Date'),
  run(8.9, y, 'Entry Date'),
  run(11.6, y, 'Customer Name'),
  run(18.3, y, 'Shipping Address'),
  run(25.1, y, 'Delivery Instructions'),
  run(33.5, y, 'Delivery Truck'),
  run(39.1, y, 'Order Attachments'),
];

const ITEM_TRACKING_BAND_TWO = (y: number) => [
  run(0.33, y, 'Order Notes'),
  run(10.46, y, 'Item Number'),
  run(16.09, y, 'Item Desc'),
  run(29.05, y, 'Qty'),
  run(30.08, y, 'Vendor'),
  run(36.24, y, 'Vendor Location'),
  run(40.7, y, 'PO Document'),
  run(45.15, y, 'PO Value'),
  run(47.6, y, 'PO Notes'),
];

/**
 * The item-tracking report: three pages of column bands describing two rows.
 *
 * The second row's description is long enough that Spruce shrinks it and prints
 * it across the Qty column, with the quantity drawn on top — the row that made
 * word-by-word reading produce nonsense.
 */
export function itemTrackingReport(): PdfTextPage[] {
  const bandOne = page(0, [
    run(1.1, 1.05, '9/2/2026 9:23 AM'),
    run(1.1, 2.54, 'Sales Order Item Tracking'),
    run(1.1, 4.2, 'Parameters'),
    ...ITEM_TRACKING_BAND_ONE(5.7),

    run(1.2, 6.58, '2608-700001'),
    run(8.9, 6.58, '9/2/2026'),
    run(11.6, 6.58, 'Riverbend Landscaping'),
    run(18.3, 6.58, '14 Mill Race Rd.,'),

    run(1.2, 7.48, '2608-700002'),
    run(5.1, 7.48, '9/5/2026'),
    run(8.9, 7.48, '9/2/2026'),
    run(11.6, 7.48, 'Harrowgate Masonry'),
    run(18.3, 7.48, 'Pickup @ Yard,'),

    run(1.2, 8.38, '2608-700002'),
    run(5.1, 8.38, '9/5/2026'),
    run(8.9, 8.38, '9/2/2026'),
    run(11.6, 8.38, 'Harrowgate Masonry'),
    run(18.3, 8.38, 'Pickup @ Yard,'),

    run(1.2, 9.28, '2608-700002'),
    run(5.1, 9.28, '9/5/2026'),
    run(8.9, 9.28, '9/2/2026'),
    run(11.6, 9.28, 'Harrowgate Masonry'),
    run(18.3, 9.28, 'Pickup @ Yard,'),

    // The revision stamp at the foot of the page.
    run(1.2, 34.4, 'Revision 2'),
  ]);

  const bandTwo = page(1, [
    ...ITEM_TRACKING_BAND_TWO(5.68),
    run(10.46, 6.58, 'SOILGRDNA'),
    run(16.09, 6.58, 'Garden Soil Bulk'),
    run(28.34, 6.58, '3.0000'),

    run(10.46, 7.48, 'BCAM48GG'),
    run(16.09, 7.48, 'Camden Step **48"** Granite Grey'),
    run(28.34, 7.48, '2.0000'),

    // A description too long for its column: shrunk by Spruce and drawn across
    // the Qty column, a little above the item code it belongs to, with the
    // quantity printed on top of it.
    run(16.09, 8.07, 'Returns accepted in full skids only and subject to a restocking fee', 2.04),
    run(10.46, 8.38, 'RETURNCOMM'),
    run(28.34, 8.38, '1.0000'),
    run(30.08, 8.38, 'STONECO01'),
    run(36.24, 8.38, 'Brantford'),
    run(40.7, 8.38, '2608-300001'),
    run(45.15, 8.38, '1,204.55'),

    run(10.46, 9.28, 'MISCDEL'),
    run(16.09, 9.28, 'Delivery Charge'),
    run(28.34, 9.28, '1.0000'),
  ]);

  const bandThree = page(2, [run(-1.9, 5.7, 'PO Notes'), run(6.5, 5.7, 'PO Attachments')]);

  return [bandOne, bandTwo, bandThree];
}

/** A second stripe of rows, to prove the bands wrap round rather than restart. */
export function itemTrackingSecondStripe(): PdfTextPage[] {
  const [first, second, third] = itemTrackingReport();

  const bandOne = page(3, [
    ...ITEM_TRACKING_BAND_ONE(4.29),
    run(1.2, 5.06, '2608-700003'),
    run(8.9, 5.06, '9/2/2026'),
    run(11.6, 5.06, 'Cash Sales'),
    run(1.2, 5.96, '2608-700003'),
    run(8.9, 5.96, '9/2/2026'),
    run(11.6, 5.96, 'Cash Sales'),
    run(1.2, 6.86, '2608-700003'),
    run(8.9, 6.86, '9/2/2026'),
    run(11.6, 6.86, 'Cash Sales'),
  ]);

  const bandTwo = page(4, [
    ...ITEM_TRACKING_BAND_TWO(4.29),
    run(10.46, 5.06, 'MULCHCEDARA'),
    run(16.09, 5.06, 'Mulch Cedar 1CY Bulk'),
    run(28.34, 5.06, '12.0000'),
    run(10.46, 5.96, 'PSSBL'),
    run(16.09, 5.96, 'Polymeric Sand Seal King Black'),
    run(28.34, 5.96, '2.0000'),
    run(10.46, 6.86, 'MISCDELI'),
    run(16.09, 6.86, 'Splitbox Delivery'),
    run(28.34, 6.86, '1.0000'),
  ]);

  return [first!, second!, third!, bandOne, bandTwo, page(5, [run(-1.9, 4.3, 'PO Notes')])];
}

// ---------------------------------------------------------------- order summary

const ORDER_SUMMARY_ORDER_HEADER = (y: number) => [
  run(1.0, y, 'Order#'),
  run(5.5, y, 'Account'),
  run(8.0, y, 'Name'),
  run(16.5, y, 'Job'),
  run(19.3, y, 'Cashier'),
  run(22.1, y, 'Branch'),
  run(25.2, y, 'Status'),
  run(27.7, y, 'Delivery'),
  run(30.2, y, 'DelvDate'),
  run(32.8, y, 'Ord'),
  run(36.5, y, 'Rem Dep'),
  run(39.8, y, 'Total w/tax'),
  run(43.7, y, 'GM%'),
  run(45.4, y, 'Remaining'),
];

const ORDER_SUMMARY_ITEM_HEADER = (y: number) => [
  run(3.0, y, 'Item'),
  run(8.3, y, 'Description'),
  run(17.5, y, 'QtyOrd'),
  run(19.3, y, 'U/M'),
  run(23.1, y, 'QtyRecv'),
  run(26.4, y, 'QOH'),
  run(28.3, y, 'QtySold'),
  run(30.2, y, 'UnitPrice'),
  run(32.8, y, 'U/M'),
  run(36.6, y, 'UnitCost'),
  run(39.2, y, 'GM%'),
];

/**
 * The order summary: an order, its items, then a second order.
 *
 * Includes a description continued over two further lines, which is what used
 * to be merged into whichever item OCR judged nearest.
 */
export function orderSummaryReport(): PdfTextPage[] {
  return [
    page(0, [
      run(0.7, 1.12, 'Branch: Test Garden Centre Inc.'),
      run(1.0, 2.93, 'Customer Order Summary'),
      ...ORDER_SUMMARY_ORDER_HEADER(6.61),

      run(1.0, 7.61, '2608-700001'),
      run(5.2, 7.61, 'RIVERBEN01'),
      run(8.0, 7.61, 'Riverbend Landscaping'),
      run(25.2, 7.61, 'Open'),
      run(32.8, 7.61, '09/02/26'),

      ...ORDER_SUMMARY_ITEM_HEADER(9.01),
      run(3.0, 9.86, 'SOILGRDNA'),
      run(8.3, 9.86, 'Garden Soil Bulk'),
      run(18.9, 9.86, '3'),
      run(19.3, 9.86, 'CY'),
      run(24.8, 9.86, '0'),
      run(27.3, 9.86, '0'),
      run(31.4, 9.86, '31.00'),

      run(1.0, 11.17, '2608-700002'),
      run(5.2, 11.17, 'HARROWGA01'),
      run(8.0, 11.17, 'Harrowgate Masonry'),
      run(25.2, 11.17, 'Open'),
      run(27.7, 11.17, 'SCH'),
      run(30.2, 11.17, '09/05/26'),
      run(32.8, 11.17, '09/02/26'),

      ...ORDER_SUMMARY_ITEM_HEADER(12.57),
      run(3.0, 13.42, 'BSKID'),
      run(8.3, 13.42, 'Bestway Skid Deposit ($35'),
      run(18.9, 13.42, '1'),
      run(19.3, 13.42, 'EA'),
      run(24.8, 13.42, '0'),
      // Continuation lines: description column only.
      run(8.3, 14.01, 'refundable upon return in good'),
      run(8.3, 14.61, 'condition)'),

      run(3.0, 15.4, 'BST24X24GR'),
      run(8.3, 15.4, '24" x 24" Standard'),
      run(18.9, 15.4, '8'),
      run(19.3, 15.4, 'EA'),
      run(8.3, 16.0, 'Patio Stone Brick Impression'),
    ]),
  ];
}

// -------------------------------------------------------------------- delivery

/**
 * The delivery run sheet, which prints no column headings at all.
 *
 * Covers the page break that used to append a letterhead onto the description
 * of the last item before it.
 */
export function deliveryReport(): PdfTextPage[] {
  return [
    page(0, [
      run(1.1, 1.11, 'Branch: Test Garden Centre Inc.'),
      run(21.4, 1.11, 'Station: C12'),
      run(1.5, 5.53, '09/02/26 - 09/02/26 (Inv / Tkt / Ord)    Qty Branch'),

      run(1.5, 8.72, '09/02/26'),
      run(4.2, 8.72, '2608-700001'),
      run(8.2, 8.72, 'Order'),
      run(10.5, 8.72, 'Sched'),
      run(16.4, 8.72, 'CASH'),
      run(21.4, 8.72, 'Cash Sales'),
      run(37.1, 8.72, '519-555-0128'),
      run(42.7, 8.72, '176.28'),
      // The person behind the trade account.
      run(16.4, 9.63, '0'),
      run(21.4, 9.63, 'Priya Raman'),

      run(4.5, 11.38, 'SOILSCRNA'),
      run(12.4, 11.38, 'Screened Soil Bulk'),
      run(29.1, 11.38, '4.0000'),
      run(31.3, 11.38, 'CY'),

      run(4.5, 12.29, 'RSKID'),
      run(12.4, 12.29, 'Rinox Skid Deposit ($35'),
      run(29.1, 12.29, '2.0000'),
      run(31.3, 12.29, 'EA'),
      run(12.4, 12.88, 'refundable upon return in good'),
      run(12.4, 13.47, 'condition)'),
    ]),
    page(1, [
      // Letterhead at the top of the next page.
      run(1.1, 1.11, 'Branch: Test Garden Centre Inc.'),
      run(21.4, 1.11, 'Station: C12'),
      run(1.5, 5.53, '09/02/26 - 09/02/26 (Inv / Tkt / Ord)    Qty Branch'),

      run(1.5, 8.72, '09/02/26'),
      run(4.2, 8.72, '2608-700002'),
      run(21.4, 8.72, 'Harrowgate Masonry'),
      run(37.1, 8.72, '519-555-6336'),
      run(42.7, 8.72, '2,149.57'),
      run(16.4, 9.63, '0'),
      run(21.4, 9.63, 'Harrowgate Masonry'),

      run(4.5, 10.53, 'AGG01'),
      run(12.4, 10.53, 'Agg "B" Type 1 PitBlk (MT)'),
      run(29.1, 10.53, '40.0000'),
      run(31.3, 10.53, 'MT'),

      run(4.5, 11.43, 'AGGSTNEDUSTA'),
      run(12.4, 11.43, 'Agg Stone Dust YrdBlk 1CY'),
      run(29.1, 11.43, '1.0000'),
      run(31.3, 11.43, 'CY'),

      run(4.5, 12.33, 'MISCDELI'),
      run(12.4, 12.33, 'Splitbox Delivery'),
      run(29.1, 12.33, '1.0000'),
      run(31.3, 12.33, 'EA'),
    ]),
  ];
}
