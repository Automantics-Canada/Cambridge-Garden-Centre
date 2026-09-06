import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatSpruceDryRun,
  summariseSpruceReport,
} from '../src/scripts/spruceDryRun.js';
import type { ParsedSpruceReport } from '../src/modules/orders/spruce/spruceReportTypes.js';

const report: ParsedSpruceReport = {
  type: 'ITEM_TRACKING',
  unreadable: [{ page: 2, row: 9, reason: 'missing quantity' }],
  rows: [
    {
      documentNumber: '9999-000001',
      customerName: 'Synthetic Customer',
      product: 'Synthetic Product A',
      itemNumber: 'ITEM-A',
      quantity: 0,
      orderDateRaw: '08/14/2026',
      poNumber: 'PO-1',
      vendorName: 'VENDOR-1',
      shippingAddress: '1 Test Street',
      source: { page: 1, row: 1 },
    },
    {
      documentNumber: '9999-000002',
      customerName: 'Synthetic Customer Two',
      product: 'Synthetic Product B',
      quantity: 2,
      orderDateRaw: '08/14/2026',
      source: { page: 1, row: 2 },
    },
  ],
};

describe('Spruce dry-run report', () => {
  it('counts documents, unreadable rows, and every parsed field without a database', () => {
    const summary = summariseSpruceReport(report);

    assert.equal(summary.type, 'ITEM_TRACKING');
    assert.equal(summary.rowCount, 2);
    assert.equal(summary.unreadableCount, 1);
    assert.deepEqual(summary.documentNumbers, ['9999-000001', '9999-000002']);
    assert.equal(summary.fillRates.find(rate => rate.field === 'quantity')?.filled, 2);
    assert.equal(summary.fillRates.find(rate => rate.field === 'itemNumber')?.filled, 1);
    assert.equal(summary.fillRates.find(rate => rate.field === 'orderNotes')?.filled, 0);
  });

  it('prints the operator-facing parse summary', () => {
    const output = formatSpruceDryRun(summariseSpruceReport(report));

    assert.match(output, /Detected type: ITEM_TRACKING/);
    assert.match(output, /Rows: 2/);
    assert.match(output, /Unreadable: 1/);
    assert.match(output, /Distinct documents: 2/);
    assert.match(output, /itemNumber: 1\/2 \(50\.0%\)/);
    assert.match(output, /quantity: 2\/2 \(100\.0%\)/);
  });
});
