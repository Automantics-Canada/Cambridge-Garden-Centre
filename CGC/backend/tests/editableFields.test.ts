import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '@prisma/client';

import {
  EditValidationError,
  columnToStored,
  parseEditRequest,
} from '../src/modules/orders/edits/editableFields.js';

describe('what a dispatcher may correct', () => {
  it('accepts the fields Spruce leaves incomplete, tidied', () => {
    const parsed = parseEditRequest({
      fields: { shippingAddress: '  90 Example Dr,   Kitchener ', deliveryDate: '2026-08-15', deliveryType: 'SLINGER', phone: '' },
      lines: [{ id: 'line-1', quantity: '11.5', product: 'Clear Stone' }],
      dispatcherNotes: 'Gate code 4411',
    });

    assert.deepEqual(parsed.order, {
      shippingAddress: '90 Example Dr, Kitchener',
      deliveryDate: '2026-08-15',
      deliveryType: 'SLINGER',
      phone: null,
    });
    assert.deepEqual(parsed.lines, [{ lineId: 'line-1', values: { quantity: '11.5', product: 'Clear Stone' } }]);
    assert.equal(parsed.dispatcherNotes, 'Gate code 4411');
  });

  it('refuses money and identity by name, rather than ignoring them', () => {
    for (const body of [
      { fields: { totalWithTax: 1 } },
      { fields: { documentNumber: '2608-000000' } },
      { lines: [{ id: 'line-1', unitPrice: 1 }] },
      { lines: [{ id: 'line-1', unitCost: 1 }] },
    ]) {
      assert.throws(() => parseEditRequest(body), (err: unknown) => err instanceof EditValidationError && /cannot be edited/.test(err.message));
    }
  });

  it('refuses values that would mislead a driver', () => {
    for (const body of [
      { fields: { customerName: '   ' } },
      { fields: { deliveryDate: '2026-02-31' } },
      { fields: { deliveryDate: 'tomorrow' } },
      { fields: { deliveryType: 'HELICOPTER' } },
      { lines: [{ id: 'line-1', quantity: '-2' }] },
      { lines: [{ id: 'line-1', quantity: 'twelve' }] },
      { lines: [{ quantity: '2' }] },
      { fields: { shippingAddress: 'x'.repeat(1001) } },
    ]) {
      assert.throws(() => parseEditRequest(body), EditValidationError, JSON.stringify(body));
    }
  });

  it('only touches the dispatcher\'s note when the request names it', () => {
    assert.equal('dispatcherNotes' in parseEditRequest({ fields: {} }), false);
    assert.equal(parseEditRequest({ dispatcherNotes: '' }).dispatcherNotes, null, 'emptied, not ignored');
  });
});

describe('comparing Spruce\'s value with a correction', () => {
  it('writes the same meaning the same way', () => {
    assert.equal(columnToStored(new Prisma.Decimal('12.0000')), '12');
    assert.equal(columnToStored(new Date('2026-08-14T00:00:00.000Z')), '2026-08-14');
    assert.equal(columnToStored('  64 Example St '), '64 Example St');
    assert.equal(columnToStored(''), null);
    assert.equal(columnToStored(null), null);
  });
});
