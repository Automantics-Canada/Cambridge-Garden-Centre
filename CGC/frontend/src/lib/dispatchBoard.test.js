import { describe, expect, it } from 'vitest';
import { mergeUnassignedOrders } from './dispatchBoard';

describe('mergeUnassignedOrders', () => {
  it('returns unassigned deliveries to the dispatch pool', () => {
    const waiting = { id: 'order-new', spruceOrderId: 'NEW-1' };
    const previouslyAssigned = { id: 'order-returned', spruceOrderId: 'RETURNED-1' };

    expect(mergeUnassignedOrders(
      [waiting],
      [{ id: 'delivery-1', order: previouslyAssigned }],
    )).toEqual([waiting, previouslyAssigned]);
  });

  it('deduplicates an order present in both API collections', () => {
    const order = { id: 'order-1', spruceOrderId: 'ONE' };

    expect(mergeUnassignedOrders([order], [{ id: 'delivery-1', order }])).toEqual([order]);
  });
});
