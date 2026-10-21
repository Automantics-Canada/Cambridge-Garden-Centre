import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { crossCheckReadings } from '../src/modules/orders/spruce/crossCheckReadings.js';
import type { ParsedSpruceRow } from '../src/modules/orders/spruce/spruceReportTypes.js';

const row = (fields: Partial<ParsedSpruceRow>): ParsedSpruceRow => ({
  documentNumber: '2610-720652',
  customerName: 'Derek',
  product: 'Proma 90mm Oka Beige',
  itemNumber: 'P90OKA',
  quantity: 255.99,
  unit: 'SQFT',
  source: { page: 1, row: 1 },
  ...fields,
});

/** One delivery-report order as both readers read it on 21/10/2026, when they agree. */
const order = (): ParsedSpruceRow[] => [
  row({ phone: '519-504-1905', deliveryDateRaw: '10/21/26' }),
  row({ itemNumber: 'RSKID', product: 'Rinox Skid Deposit ($35 refundable upon return in good condition)', quantity: 3, unit: 'EA' }),
  row({ itemNumber: 'COMMENT', product: '3 Skids', quantity: 1, unit: undefined }),
];

describe('crossCheckReadings', () => {
  it('agrees where both readers read the same, whatever the spacing', () => {
    const ai = order().map(line => ({ ...line, source: { page: 9, row: 9 } }));
    ai[1] = { ...ai[1]!, product: 'Rinox Skid Deposit ($35 refundable upon return in good  condition)' };

    assert.deepEqual(crossCheckReadings(order(), ai), { compared: 3, agreed: 3, differences: [] });
  });

  it('names the order and the field where they differ: the 21/10/2026 "U/M" customers', () => {
    const reader = order().map(line => ({ ...line, customerName: 'U/M' }));

    const check = crossCheckReadings(reader, order());

    assert.equal(check.agreed, 0);
    // One difference per order and field, not one per line.
    assert.deepEqual(check.differences, [
      { documentNumber: '2610-720652', detail: 'customer read as "U/M" by the report reader, "Derek" by AI' },
    ]);
  });

  it('catches a line read onto the wrong order', () => {
    const ai = [...order(), row({ documentNumber: '2610-720700', itemNumber: 'RSKID', product: 'Rinox Skid Deposit', quantity: 3, unit: 'EA' })];
    ai.splice(1, 1);

    const { differences } = crossCheckReadings(order(), ai);

    assert.deepEqual(differences.map(d => d.documentNumber), ['2610-720652', '2610-720700']);
    assert.match(differences[0]!.detail, /RSKID .* x 3: found by the report reader, not by AI/);
    assert.match(differences[1]!.detail, /RSKID Rinox Skid Deposit x 3: found by AI, not by the report reader/);
  });

  it('does not hold an order against the layout reader where the AI was unsure of it', () => {
    const ai = order().slice(0, 1);

    assert.deepEqual(crossCheckReadings(order(), ai, new Set(['2610-720652'])).differences, []);
    assert.equal(crossCheckReadings(order(), ai).differences.length, 1, 'the skid line; comments are not compared');
  });

  it('compares comment lines as present, not word for word', () => {
    const ai = order();
    ai[2] = { ...ai[2]!, product: '3 skids, 4 layers' };

    assert.deepEqual(crossCheckReadings(order(), ai).differences, []);
  });

  it('compares figures as numbers', () => {
    const ai = order();
    ai[0] = { ...ai[0]!, quantity: 255.99000001 };
    assert.deepEqual(crossCheckReadings(order(), ai).differences, []);

    ai[0] = { ...ai[0]!, quantity: 25.599 };
    assert.equal(crossCheckReadings(order(), ai).differences.length, 1);
  });
});
