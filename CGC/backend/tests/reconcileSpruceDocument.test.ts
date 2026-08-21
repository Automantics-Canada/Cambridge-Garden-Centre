import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  reconcileDocumentLines,
  type ExistingLine,
} from '../src/modules/orders/spruce/reconcileSpruceDocument.js';
import type { ParsedSpruceRow } from '../src/modules/orders/spruce/spruceReportTypes.js';

let seq = 0;

function row(
  itemNumber: string | undefined,
  product: string,
  quantity: number,
  unit?: string
): ParsedSpruceRow {
  seq += 1;
  return {
    documentNumber: '2608-700001',
    customerName: 'Test Customer',
    product,
    quantity,
    ...(itemNumber ? { itemNumber } : {}),
    ...(unit ? { unit } : {}),
    source: { page: 1, row: seq },
  };
}

function stored(
  id: string,
  product: string,
  quantity: number,
  options: {
    unit?: string;
    spruceItemNumber?: string;
    lineNumber?: number;
    poNumber?: string;
    hasOperationalLinks?: boolean;
  } = {}
): ExistingLine {
  return {
    id,
    product,
    quantity,
    unit: options.unit ?? null,
    spruceItemNumber: options.spruceItemNumber ?? null,
    lineNumber: options.lineNumber ?? null,
    poNumber: options.poNumber ?? null,
    hasOperationalLinks: options.hasOperationalLinks ?? false,
  };
}

describe('reconcileDocumentLines', () => {
  it('pairs an identical re-import without touching anything', () => {
    const existing = [
      stored('a', 'Garden Soil Bulk', 3, { spruceItemNumber: 'SOILGRDNA', unit: 'CY', lineNumber: 1 }),
      stored('b', 'Delivery Charge', 1, { spruceItemNumber: 'MISCDEL', lineNumber: 2 }),
    ];
    const incoming = [
      row('SOILGRDNA', 'Garden Soil Bulk', 3, 'CY'),
      row('MISCDEL', 'Delivery Charge', 1),
    ];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.createIndices, []);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.absentIds, []);
    assert.equal(plan.paired.length, 2);
    assert.ok(plan.paired.every(p => p.kind === 'unchanged'));
  });

  it('keeps every row identity when the reports print the lines in different orders', () => {
    // The real sequences for document 2608-712590 on the sample day: the
    // Customer Order Summary and Item Tracking report disagree about which
    // line comes first, second and fifth.
    const existing = [
      stored('c1', '**Special Order, Purchase and Returns in full skids only**', 1, { spruceItemNumber: 'COMMENT', lineNumber: 1 }),
      stored('b1', 'BeaconHill Smooth 60mm Midnight', 104.91, { spruceItemNumber: 'BHS6CSR', unit: 'SQFT', lineNumber: 2 }),
      stored('b2', 'BeaconHill Smooth 60mm Fossil', 629.46, { spruceItemNumber: 'BHS6F', unit: 'SQFT', lineNumber: 3 }),
      stored('u1', 'Unilock Skid Deposit ($35 refundable upon return in good condition)', 1, { spruceItemNumber: 'USKID', lineNumber: 4 }),
      stored('u2', 'Unilock Skid Deposit ($35 refundable upon return in good condition)', 6, { spruceItemNumber: 'USKID', lineNumber: 5 }),
      stored('m1', 'Delivery Charge', 1, { spruceItemNumber: 'MISCDEL', lineNumber: 6 }),
    ];
    const incoming = [
      row('BHS6CSR', 'BeaconHill Smooth 60mm Midnight', 104.91, 'SQFT'),
      row('BHS6F', 'BeaconHill Smooth 60mm Fossil', 629.46, 'SQFT'),
      row('COMMENT', '**Special Order, Purchase and Returns in full skids only**', 1),
      row('MISCDEL', 'Delivery Charge', 1),
      row('USKID', 'Unilock Skid Deposit ($35 refundable upon return in good condition)', 1),
      row('USKID', 'Unilock Skid Deposit ($35 refundable upon return in good condition)', 6),
    ];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.createIndices, [], 'nothing new');
    assert.deepEqual(plan.conflicts, []);
    assert.equal(plan.paired.length, 6);

    const byIncomingIndex = new Map(plan.paired.map(p => [p.incomingIndex, p]));
    // Each report line found the row that carries its own item, wherever the
    // other report printed that row.
    assert.equal(byIncomingIndex.get(0)!.id, 'b1');
    assert.equal(byIncomingIndex.get(1)!.id, 'b2');
    assert.equal(byIncomingIndex.get(2)!.id, 'c1');
    assert.equal(byIncomingIndex.get(3)!.id, 'm1');
    assert.equal(byIncomingIndex.get(4)!.id, 'u1');
    assert.equal(byIncomingIndex.get(5)!.id, 'u2');
  });

  it('pairs repeated codes by quantity, so swapped report order cannot swap identities', () => {
    const existing = [
      stored('big', 'Unilock Skid Deposit', 6, { spruceItemNumber: 'USKID', lineNumber: 1, hasOperationalLinks: true }),
      stored('small', 'Unilock Skid Deposit', 1, { spruceItemNumber: 'USKID', lineNumber: 2 }),
    ];
    const incoming = [
      row('USKID', 'Unilock Skid Deposit', 1),
      row('USKID', 'Unilock Skid Deposit', 6),
    ];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.conflicts, []);
    const byIncomingIndex = new Map(plan.paired.map(p => [p.incomingIndex, p]));
    assert.equal(byIncomingIndex.get(0)!.id, 'small');
    assert.equal(byIncomingIndex.get(1)!.id, 'big');
  });

  it('uses a unique quantity when repeated-code descriptions differ between reports', () => {
    const existing = [
      stored('small', 'Unilock refundable pallet charge', 1, {
        spruceItemNumber: 'USKID',
      }),
      stored('large', 'Unilock refundable pallet charge', 6, {
        spruceItemNumber: 'USKID',
      }),
    ];
    const incoming = [
      row('USKID', 'Unilock Skid Deposit ($35 refundable upon return)', 6),
      row('USKID', 'Unilock Skid Deposit ($35 refundable upon return)', 1),
    ];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.paired.map(pair => pair.id), ['large', 'small']);
  });

  it('adopts a legacy row by description and gives it its item code', () => {
    const existing = [
      stored('legacy', 'Garden Soil Bulk', 3, { unit: 'CY', lineNumber: 1 }),
    ];
    const incoming = [row('SOILGRDNA', 'Garden Soil Bulk', 3, 'CY')];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.createIndices, []);
    assert.equal(plan.paired.length, 1);
    assert.equal(plan.paired[0]!.kind, 'update');
    assert.equal(
      plan.paired[0]!.kind === 'update' ? plan.paired[0]!.patch.spruceItemNumber : undefined,
      'SOILGRDNA'
    );
  });

  it('refuses to guess between invoiced duplicates whose quantities all differ', () => {
    const existing = [
      stored('invoiced-6', 'Unilock Skid Deposit', 6, { spruceItemNumber: 'USKID', lineNumber: 1, hasOperationalLinks: true }),
      stored('plain-1', 'Unilock Skid Deposit', 1, { spruceItemNumber: 'USKID', lineNumber: 2 }),
    ];
    const incoming = [row('USKID', 'Unilock Skid Deposit', 2)];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.equal(plan.paired.length, 0);
    assert.equal(plan.conflicts.length, 1);
    assert.match(plan.conflicts[0]!.reason, /USKID/);
  });

  it('uses an existing PO to distinguish otherwise identical operational rows', () => {
    const existing = [
      stored('po-a', 'Miscellaneous Charge', 1, {
        spruceItemNumber: 'MISC',
        poNumber: 'PO-A',
        hasOperationalLinks: true,
      }),
      stored('po-b', 'Miscellaneous Charge', 1, {
        spruceItemNumber: 'MISC',
        poNumber: 'PO-B',
        hasOperationalLinks: true,
      }),
    ];
    const first = row('MISC', 'Miscellaneous Charge', 1);
    first.poNumber = 'PO-B';
    const second = row('MISC', 'Miscellaneous Charge', 1);
    second.poNumber = 'PO-A';

    const plan = reconcileDocumentLines([first, second], existing);

    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(
      plan.paired.map(pair => pair.id),
      ['po-b', 'po-a']
    );
  });

  it('refuses identical operational duplicates when no report field distinguishes them', () => {
    const existing = [
      stored('linked', 'Miscellaneous Charge', 1, {
        spruceItemNumber: 'MISC',
        hasOperationalLinks: true,
      }),
      stored('plain', 'Miscellaneous Charge', 1, {
        spruceItemNumber: 'MISC',
      }),
    ];

    const plan = reconcileDocumentLines(
      [row('MISC', 'Miscellaneous Charge', 1)],
      existing
    );

    assert.equal(plan.paired.length, 0);
    assert.equal(plan.conflicts.length, 1);
  });

  it('creates lines the document has never seen', () => {
    const existing = [
      stored('a', 'Garden Soil Bulk', 3, { spruceItemNumber: 'SOILGRDNA', lineNumber: 1 }),
    ];
    const incoming = [
      row('SOILGRDNA', 'Garden Soil Bulk', 3),
      row('AGG3/4C', '3/4" Clear PitBlk (MT)', 12, 'MT'),
    ];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.createIndices, [1]);
    assert.equal(plan.paired.length, 1);
  });

  it('reports lines the report no longer mentions instead of deleting them', () => {
    const existing = [
      stored('a', 'Garden Soil Bulk', 3, { spruceItemNumber: 'SOILGRDNA', lineNumber: 1 }),
      stored('gone', 'Rinox Skid Deposit', 2, { spruceItemNumber: 'RSKID', lineNumber: 2 }),
    ];
    const incoming = [row('SOILGRDNA', 'Garden Soil Bulk', 3)];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.absentIds, ['gone']);
  });

  it('matches uncoded comment lines by their wording', () => {
    const existing = [
      stored('c1', 'Requested: 2 Camden Steps 48" Granite Grey', 1, { lineNumber: 1 }),
    ];
    const incoming = [row(undefined, 'Requested: 2 Camden Steps 48" Granite Grey', 1)];

    const plan = reconcileDocumentLines(incoming, existing);

    assert.deepEqual(plan.createIndices, []);
    assert.equal(plan.paired[0]!.kind, 'unchanged');
    assert.equal(plan.paired[0]!.id, 'c1');
  });
});
