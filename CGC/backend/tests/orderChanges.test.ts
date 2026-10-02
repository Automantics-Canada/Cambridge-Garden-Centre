import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DELIVERY_DRIVER_RESPONSE_SELECT } from '../src/modules/deliveries/deliveries.service.js';
import { DISPATCH_DOCUMENT_SELECT } from '../src/modules/dispatch/dispatchOrderView.js';
import {
  LINE_ADDED,
  LINE_REMOVED,
  diffOrder,
  lineLabel,
  summariseChanges,
  type LineSnapshot,
  type OrderSnapshot,
} from '../src/modules/orders/import/orderChanges.js';

/** A synthetic order as an upload finds it; every value is invented. */
function snapshot(overrides: Partial<OrderSnapshot['fields']> = {}, lines?: LineSnapshot[]): OrderSnapshot {
  return {
    fields: {
      customerName: 'Pat Example',
      phone: '519-555-0100',
      route: 'NORTH',
      shippingAddress: '64 Example St, Kitchener',
      deliveryInstructions: 'Call before',
      deliveryTruck: null,
      deliveryDate: '2026-09-02',
      deliveryType: 'SLINGER',
      ...overrides,
    },
    lines: lines ?? [line('line-1'), line('line-2', { product: 'Slinger Spreading', quantity: '1', unit: 'EA' })],
  };
}

function line(id: string, values: Partial<LineSnapshot> = {}): LineSnapshot {
  return { id, product: '3/4" Clear', quantity: '12', unit: 'MT', removed: false, ...values };
}

const printed = (...ids: string[]) => ({ paired: new Set(ids), created: new Set<string>() });

describe('what an upload changed on an order', () => {
  it('logs nothing when the reports say what they said before', () => {
    assert.deepEqual(diffOrder(snapshot(), snapshot(), printed('line-1', 'line-2')), []);
  });

  it('logs each changed field with what it was and what it is', () => {
    const after = snapshot({ shippingAddress: '70 Example St, Kitchener', deliveryDate: '2026-09-03' });
    assert.deepEqual(diffOrder(snapshot(), after, printed('line-1', 'line-2')), [
      { lineId: null, field: 'shippingAddress', oldValue: '64 Example St, Kitchener', newValue: '70 Example St, Kitchener' },
      { lineId: null, field: 'deliveryDate', oldValue: '2026-09-02', newValue: '2026-09-03' },
    ]);
  });

  it('logs a field Spruce filled in or emptied', () => {
    const after = snapshot({ deliveryTruck: 'Small truck', deliveryInstructions: null });
    assert.deepEqual(
      diffOrder(snapshot(), after, printed('line-1', 'line-2')).map(change => [change.field, change.oldValue, change.newValue]),
      [['deliveryInstructions', 'Call before', null], ['deliveryTruck', null, 'Small truck']]
    );
  });

  it('logs a changed quantity and description against their line', () => {
    const after = snapshot({}, [line('line-1', { quantity: '14', product: '3/4" Clear Stone' }), line('line-2', { product: 'Slinger Spreading', quantity: '1', unit: 'EA' })]);
    assert.deepEqual(diffOrder(snapshot(), after, printed('line-1', 'line-2')), [
      { lineId: 'line-1', field: 'product', oldValue: '3/4" Clear', newValue: '3/4" Clear Stone' },
      { lineId: 'line-1', field: 'quantity', oldValue: '12', newValue: '14' },
    ]);
  });

  it('logs a line the upload added, and one no report printed any more', () => {
    const before = snapshot();
    const after = snapshot({}, [...before.lines, line('line-3', { product: 'Topsoil', quantity: '3', unit: 'CY' })]);
    const seen = { paired: new Set(['line-1']), created: new Set(['line-3']) };

    assert.deepEqual(diffOrder(before, after, seen), [
      { lineId: 'line-2', field: LINE_REMOVED, oldValue: '1 EA Slinger Spreading', newValue: null },
      { lineId: 'line-3', field: LINE_ADDED, oldValue: null, newValue: '3 CY Topsoil' },
    ]);
  });

  it('logs a removed line once, and again only when it comes back', () => {
    const gone = snapshot({}, [line('line-1'), line('line-2', { removed: true })]);
    assert.deepEqual(diffOrder(gone, gone, printed('line-1')), [], 'still left out: already logged');
    assert.deepEqual(diffOrder(gone, gone, printed('line-1', 'line-2')), [
      { lineId: 'line-2', field: LINE_ADDED, oldValue: null, newValue: '12 MT 3/4" Clear' },
    ]);
  });

  it('reads a line as the yard writes it', () => {
    assert.equal(lineLabel({ product: '3/4" Clear', quantity: '12', unit: 'MT' }), '12 MT 3/4" Clear');
    assert.equal(lineLabel({ product: 'Comment', quantity: null, unit: null }), 'Comment');
  });
});

describe('what the screens show from the day\'s changes', () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 8, 2, hour));

  it('reads two changes to one field as one, from the morning value to the latest', () => {
    const summary = summariseChanges([
      { lineId: null, field: 'shippingAddress', oldValue: 'A St', newValue: 'B St', createdAt: at(14) },
      { lineId: null, field: 'shippingAddress', oldValue: 'B St', newValue: 'C St', createdAt: at(16) },
    ], []);
    assert.deepEqual(summary.updatedFields, ['shippingAddress']);
    assert.equal(summary.updates[0]!.oldValue, 'A St');
    assert.equal(summary.updates[0]!.newValue, 'C St');
    assert.deepEqual(summary.updates[0]!.changedAt, at(16));
  });

  it('drops a field changed and changed back', () => {
    const summary = summariseChanges([
      { lineId: 'line-1', field: 'quantity', oldValue: '12', newValue: '14', createdAt: at(14) },
      { lineId: 'line-1', field: 'quantity', oldValue: '14', newValue: '12', createdAt: at(16) },
    ], []);
    assert.deepEqual(summary, { updatedFields: [], updates: [] });
  });

  it('leaves out a field the dispatcher corrected, whose driver still sees the correction', () => {
    const summary = summariseChanges([
      { lineId: null, field: 'phone', oldValue: '519-555-0100', newValue: '519-555-0199', createdAt: at(14) },
      { lineId: null, field: 'route', oldValue: 'NORTH', newValue: 'SOUTH', createdAt: at(14) },
      { lineId: 'line-1', field: 'quantity', oldValue: '12', newValue: '14', createdAt: at(14) },
    ], [{ field: 'phone', lineId: null }, { field: 'quantity', lineId: 'line-1' }]);
    assert.deepEqual(summary.updatedFields, ['route']);
  });

  it('lists the fields in a fixed order, each once', () => {
    const summary = summariseChanges([
      { lineId: 'line-9', field: LINE_ADDED, oldValue: null, newValue: '3 CY Topsoil', createdAt: at(14) },
      { lineId: 'line-1', field: 'quantity', oldValue: '12', newValue: '14', createdAt: at(14) },
      { lineId: 'line-2', field: 'quantity', oldValue: '1', newValue: '2', createdAt: at(14) },
      { lineId: null, field: 'shippingAddress', oldValue: null, newValue: 'B St', createdAt: at(14) },
    ], []);
    assert.deepEqual(summary.updatedFields, ['shippingAddress', 'quantity', LINE_ADDED]);
    assert.equal(summary.updates.length, 4);
  });

  it('reads a line added and then taken off the same day as nothing', () => {
    const summary = summariseChanges([
      { lineId: 'line-9', field: LINE_ADDED, oldValue: null, newValue: '3 CY Topsoil', createdAt: at(14) },
      { lineId: 'line-9', field: LINE_REMOVED, oldValue: '3 CY Topsoil', newValue: null, createdAt: at(16) },
    ], []);
    assert.deepEqual(summary.updatedFields, []);
  });
});

describe('what drivers are sent', () => {
  it('reads the board\'s changes apart from the select a driver\'s stop shares', () => {
    // DISPATCH_DOCUMENT_SELECT is also the `document` of every delivery
    // response, drivers' included. Its keys are pinned so nothing added for
    // the board reaches a phone.
    assert.deepEqual(Object.keys(DISPATCH_DOCUMENT_SELECT).sort(), [
      '_count', 'addressNormalized', 'createdAt', 'customerName', 'deliveryDate', 'deliveryInstructions',
      'deliveryType', 'dispatcherNotes', 'documentNumber', 'flags', 'id', 'lines', 'phone', 'shippingAddress',
    ]);
    assert.deepEqual(DISPATCH_DOCUMENT_SELECT._count, { select: { overrides: true } });
    assert.deepEqual(Object.keys(DISPATCH_DOCUMENT_SELECT.lines.select).sort(), [
      'id', 'lineClass', 'lineNumber', 'product', 'quantity', 'spruceItemNumber', 'unit',
    ]);
  });

  it('keeps the driver\'s stop to the fields it had', () => {
    assert.deepEqual(Object.keys(DELIVERY_DRIVER_RESPONSE_SELECT).sort(), [
      'completedAt', 'createdAt', 'deliveryPhotoUrl', 'document', 'driver', 'driverId', 'history', 'id',
      'order', 'orderId', 'pickupPhotoUrl', 'priority', 'startedAt', 'status',
    ]);
    assert.equal(DELIVERY_DRIVER_RESPONSE_SELECT.document.select, DISPATCH_DOCUMENT_SELECT);
    const selected = JSON.stringify(DELIVERY_DRIVER_RESPONSE_SELECT);
    for (const key of ['changes', 'updatedFields', 'oldValue', 'newValue']) {
      assert.equal(selected.includes(`"${key}"`), false, `${key} must not reach a driver`);
    }
  });
});
