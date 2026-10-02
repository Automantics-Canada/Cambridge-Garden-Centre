import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeliveryQueryError, parseDeliveryQuery } from '../src/modules/deliveries/deliveryQuery.js';

describe('parseDeliveryQuery', () => {
  it('defaults to a bounded first page', () => {
    const parsed = parseDeliveryQuery({});
    assert.deepEqual(parsed.filters, {});
    assert.equal(parsed.page, 1);
    assert.equal(parsed.limit, 50);
    assert.equal(parsed.wantsEnvelope, false);
  });

  it('caps the requested page size and returns the pagination envelope', () => {
    const parsed = parseDeliveryQuery({ page: '2', limit: '500' });
    assert.equal(parsed.page, 2);
    assert.equal(parsed.limit, 100);
    assert.equal(parsed.wantsEnvelope, true);
  });

  it('files a stop under the day its order goes out', () => {
    const parsed = parseDeliveryQuery({ date: '2026-08-16' });
    const [day] = parsed.filters.AND as Array<{ OR: any[] }>;
    const [byOrder, byCreation] = day!.OR;

    assert.equal(byOrder.document.is.deliveryDate.toISOString(), '2026-08-16T00:00:00.000Z');
    // A stop made before orders were dispatched whole only knows when it was
    // made, read on Cambridge's calendar.
    assert.equal(byCreation.documentId, null);
    assert.equal(byCreation.createdAt.gte.toISOString(), '2026-08-16T04:00:00.000Z');
    assert.equal(byCreation.createdAt.lte.toISOString(), '2026-08-17T03:59:59.999Z');
  });

  it('searches orders, their lines and drivers, alongside a date', () => {
    const parsed = parseDeliveryQuery({ search: '  Green  ', date: '2026-08-16' });
    const conditions = parsed.filters.AND as Array<{ OR: unknown[] }>;
    assert.equal(conditions.length, 2, 'the search must not replace the date');
    assert.equal(conditions[1]!.OR.length, 6);
    assert.match(JSON.stringify(conditions[1]), /Green/);
    assert.doesNotMatch(JSON.stringify(conditions[1]), / Green|Green /, 'the term is trimmed');
  });

  it('rejects invalid dates, enums, pagination and multi-value input', () => {
    const badQueries = [
      { date: '2026-02-31' },
      { status: 'DONE' },
      { priority: '0' },
      { page: 'nope' },
      { driverId: ['one', 'two'] },
    ];
    for (const query of badQueries) {
      assert.throws(() => parseDeliveryQuery(query), DeliveryQueryError);
    }
  });
});
