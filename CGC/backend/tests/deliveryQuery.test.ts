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

  it('uses Cambridge boundaries for a selected date', () => {
    const parsed = parseDeliveryQuery({ date: '2026-08-16' });
    const createdAt = parsed.filters.createdAt as { gte: Date; lte: Date };
    assert.equal(createdAt.gte.toISOString(), '2026-08-16T04:00:00.000Z');
    assert.equal(createdAt.lte.toISOString(), '2026-08-17T03:59:59.999Z');
  });

  it('builds server-side order and driver search predicates', () => {
    const parsed = parseDeliveryQuery({ search: '  Green  ' });
    assert.equal(parsed.filters.OR?.length, 4);
    assert.match(JSON.stringify(parsed.filters.OR), /Green/);
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
