import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PdfTextRun } from '../src/lib/pdf/pdfWords.js';
import {
  assignToBands,
  clusterRows,
  deriveBands,
  deriveRowTolerance,
  findHeaderRow,
  joinRunText,
  rowText,
  type ColumnSpec,
} from '../src/lib/pdf/textGeometry.js';

/**
 * Coordinates here are taken from the item-tracking report: rows are pitched
 * 0.9 apart, a description sits up to 0.31 above its own item code, and the Qty
 * column is right-aligned so its values start left of its heading.
 */
function run(x: number, y: number, text: string): PdfTextRun {
  return { text, x, y, w: text.length * 0.3, fontSize: 13.7 };
}

const ITEM_TRACKING_COLUMNS: ColumnSpec[] = [
  { key: 'orderNotes', phrase: 'Order Notes' },
  { key: 'itemNumber', phrase: 'Item Number' },
  { key: 'itemDesc', phrase: 'Item Desc' },
  { key: 'qty', phrase: 'Qty' },
  { key: 'vendor', phrase: 'Vendor' },
  { key: 'poDocument', phrase: 'PO Document' },
];

function headerRuns(y = 5.7): PdfTextRun[] {
  return [
    run(0.33, y, 'Order Notes'),
    run(10.46, y, 'Item Number'),
    run(16.09, y, 'Item Desc'),
    run(29.05, y, 'Qty'),
    run(30.08, y, 'Vendor'),
    run(40.7, y, 'PO Document'),
  ];
}

describe('deriveRowTolerance', () => {
  it('lands between the widest within-row offset and the tightest row spacing', () => {
    // 0.9 pitch, with a description drawn 0.31 above its item code.
    const ys = [6.58, 7.48, 8.38, 9.18, 9.29, 10.19, 11.09, 11.99, 12.89];

    const tolerance = deriveRowTolerance(ys);

    assert.ok(tolerance > 0.31, `expected > 0.31 to keep a row together, got ${tolerance}`);
    assert.ok(tolerance < 0.8, `expected < 0.8 to keep rows apart, got ${tolerance}`);
  });

  it('is not dragged down by the jitter within rows', () => {
    // Parts of one row can differ in the second decimal. On the sample reports
    // between a quarter and a half of all gaps are this jitter rather than
    // spacing, so the estimate has to look past them.
    const ys: number[] = [];
    for (let i = 0; i < 20; i++) {
      const base = 6.58 + i * 0.9;
      ys.push(base);
      if (i % 2 === 0) ys.push(base + 0.02);
    }

    const tolerance = deriveRowTolerance(ys);

    assert.ok(tolerance > 0.02, `must clear the jitter, got ${tolerance}`);
    assert.ok(tolerance < 0.9, `must not reach the next row, got ${tolerance}`);
  });

  it('is not dragged up by one outsized gap such as a footer', () => {
    const ys = [6.58, 7.48, 8.38, 9.28, 10.18, 11.08, 34.4];

    const tolerance = deriveRowTolerance(ys);

    assert.ok(tolerance < 0.9, `a single 23-unit gap must not widen the tolerance, got ${tolerance}`);
  });

  it('returns zero when there is nothing to derive from', () => {
    assert.equal(deriveRowTolerance([]), 0);
    assert.equal(deriveRowTolerance([6.58]), 0);
    assert.equal(deriveRowTolerance([6.58, 6.58]), 0);
  });
});

describe('clusterRows', () => {
  it('keeps a description with the item code it is offset from', () => {
    // Enough rows for the spacing to be readable, as any real page has.
    const rows = clusterRows([
      run(16.09, 9.18, 'Bestway Skid Deposit ($35 refundable upon return in good condition)'),
      run(10.46, 9.29, 'BSKID'),
      run(28.34, 9.29, '1.0000'),
      run(16.09, 10.08, 'Camden Step Filler Granite Grey'),
      run(10.46, 10.19, 'BCAM28GG'),
      run(28.34, 10.19, '2.0000'),
      run(10.46, 11.09, 'SOILGRDNA'),
      run(16.09, 11.09, 'Garden Soil Bulk'),
      run(28.34, 11.09, '3.0000'),
      run(10.46, 11.99, 'MISCDEL'),
      run(16.09, 11.99, 'Delivery Charge'),
      run(28.34, 11.99, '1.0000'),
    ]);

    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0]?.runs.map(r => r.text), [
      'BSKID',
      'Bestway Skid Deposit ($35 refundable upon return in good condition)',
      '1.0000',
    ]);
    assert.deepEqual(rows[1]?.runs.map(r => r.text), ['BCAM28GG', 'Camden Step Filler Granite Grey', '2.0000']);
  });

  it('does not merge two genuine rows', () => {
    const rows = clusterRows([
      run(10.46, 6.58, 'SOILGRDNA'),
      run(10.46, 7.48, 'BCAM28GG'),
      run(10.46, 8.38, 'BCAM48GG'),
    ]);

    assert.equal(rows.length, 3);
  });

  it('orders a row left to right whatever order the runs arrive in', () => {
    const rows = clusterRows([run(28.34, 6.58, 'qty'), run(10.46, 6.58, 'item'), run(16.09, 6.58, 'desc')]);

    assert.deepEqual(rows[0]?.runs.map(r => r.text), ['item', 'desc', 'qty']);
  });

  it('reports a row at the topmost y of its runs', () => {
    const rows = clusterRows([run(16.09, 9.18, 'desc'), run(10.46, 9.29, 'BSKID')]);

    assert.equal(rows[0]?.y, 9.18);
  });

  it('honours an explicit tolerance over the derived one', () => {
    const runs = [run(16.09, 9.18, 'desc'), run(10.46, 9.29, 'BSKID')];

    assert.equal(clusterRows(runs, 0.05).length, 2);
    assert.equal(clusterRows(runs, 0.5).length, 1);
  });

  it('returns nothing for no runs', () => {
    assert.deepEqual(clusterRows([]), []);
  });
});

describe('findHeaderRow', () => {
  it('picks the row matching the most columns, not the first partial match', () => {
    // The title block repeats "Document", which is where a first-match rule
    // would anchor every column boundary.
    const rows = clusterRows([
      run(1.2, 2.4, 'Sales Order Item Tracking'),
      run(1.2, 3.3, 'Document'),
      ...headerRuns(5.7),
    ]);

    const match = findHeaderRow(rows, ITEM_TRACKING_COLUMNS);

    assert.equal(match?.hits.size, 6);
    assert.equal(match?.row.y, 5.7);
  });

  it('reports only the columns it found', () => {
    const rows = clusterRows([run(10.46, 5.7, 'Item Number'), run(16.09, 5.7, 'Item Desc')]);

    const match = findHeaderRow(rows, ITEM_TRACKING_COLUMNS);

    assert.deepEqual([...(match?.hits.keys() ?? [])].sort(), ['itemDesc', 'itemNumber']);
  });

  it('matches regardless of case and spacing', () => {
    const rows = clusterRows([run(40.7, 5.7, 'PO   document')]);

    assert.ok(findHeaderRow(rows, ITEM_TRACKING_COLUMNS)?.hits.has('poDocument'));
  });

  it('returns null when there are no rows', () => {
    assert.equal(findHeaderRow([], ITEM_TRACKING_COLUMNS), null);
  });
});

describe('deriveBands', () => {
  const bandsFor = (columns = ITEM_TRACKING_COLUMNS) => {
    const rows = clusterRows(headerRuns());
    return deriveBands(findHeaderRow(rows, columns)!, 49.5);
  };

  it('puts a boundary midway between neighbouring headers', () => {
    const bands = bandsFor();
    const itemDesc = bands.find(b => b.key === 'itemDesc')!;

    assert.equal(itemDesc.x0, (10.46 + 16.09) / 2);
    assert.equal(itemDesc.x1, (16.09 + 29.05) / 2);
  });

  it('claims a right-aligned value that starts left of its own heading', () => {
    // Qty is headed at 29.05 and filled from 28.34. A boundary drawn on the
    // heading would file every quantity under the description beside it.
    const bands = bandsFor();
    const qty = bands.find(b => b.key === 'qty')!;

    assert.ok(28.34 >= qty.x0 && 28.34 < qty.x1, 'a right-aligned quantity must fall in the Qty band');
  });

  it('lets the first band run left and the last run past the page edge', () => {
    const bands = bandsFor();

    assert.equal(bands[0]?.x0, Number.NEGATIVE_INFINITY);
    assert.ok(bands[bands.length - 1]!.x1 > 49.5);
  });

  it('orders bands left to right whatever order the columns were given in', () => {
    const bands = bandsFor();

    assert.deepEqual(bands.map(b => b.key), [
      'orderNotes',
      'itemNumber',
      'itemDesc',
      'qty',
      'vendor',
      'poDocument',
    ]);
  });

  it('gives no band to a column the report does not have', () => {
    const rows = clusterRows([run(10.46, 5.7, 'Item Number'), run(16.09, 5.7, 'Item Desc')]);
    const bands = deriveBands(findHeaderRow(rows, ITEM_TRACKING_COLUMNS)!, 49.5);

    assert.deepEqual(bands.map(b => b.key), ['itemNumber', 'itemDesc']);
  });
});

describe('assignToBands', () => {
  const bands = deriveBands(findHeaderRow(clusterRows(headerRuns()), ITEM_TRACKING_COLUMNS)!, 49.5);

  it('keeps a description that overflows into the next column', () => {
    // Spruce draws an over-long description across the Qty column, with the
    // quantity on top of it. The description still starts in its own column.
    const overflowing = run(16.09, 12.57, 'CGC Stocked Interlock & Walls is only accepted back in full skids');
    overflowing.w = 20;

    const cells = assignToBands({ y: 12.57, runs: [overflowing, run(28.34, 12.57, '1.0000')] }, bands);

    assert.deepEqual(cells.itemDesc?.map(r => r.text), [overflowing.text]);
    assert.deepEqual(cells.qty?.map(r => r.text), ['1.0000']);
  });

  it('files each run under its column', () => {
    const cells = assignToBands(
      { y: 6.58, runs: [run(10.46, 6.58, 'SOILGRDNA'), run(16.09, 6.58, 'Garden Soil Bulk'), run(28.34, 6.58, '3.0000')] },
      bands
    );

    assert.deepEqual(Object.keys(cells).sort(), ['itemDesc', 'itemNumber', 'qty']);
  });

  it('ignores a run left of every band', () => {
    const narrow = [{ key: 'qty', x0: 22.6, x1: 29.6 }];

    assert.deepEqual(assignToBands({ y: 6.58, runs: [run(1.2, 6.58, 'stray')] }, narrow), {});
  });
});

describe('joinRunText and rowText', () => {
  it('joins a cell in reading order and collapses whitespace', () => {
    assert.equal(joinRunText([run(16.5, 1, 'Granite  Grey'), run(16.09, 1, 'Camden Step')]), 'Camden Step Granite Grey');
  });

  it('returns an empty string for a missing or empty cell', () => {
    assert.equal(joinRunText(undefined), '');
    assert.equal(joinRunText([]), '');
  });

  it('omits columns with no text rather than emitting blanks', () => {
    const bands = deriveBands(findHeaderRow(clusterRows(headerRuns()), ITEM_TRACKING_COLUMNS)!, 49.5);
    const text = rowText({ y: 6.58, runs: [run(10.46, 6.58, 'SOILGRDNA')] }, bands);

    assert.deepEqual(text, { itemNumber: 'SOILGRDNA' });
  });
});
