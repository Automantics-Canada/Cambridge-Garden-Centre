import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './setupEnv.js';
import {
  DELIVERY_DRIVER_RESPONSE_SELECT,
  DELIVERY_RESPONSE_SELECT,
} from '../src/modules/deliveries/deliveries.service.js';

describe('delivery response projections', () => {
  it('keeps the operations list lean', () => {
    const order = DELIVERY_RESPONSE_SELECT.order.select as Record<string, unknown>;
    assert.equal(order.shippingAddress, undefined);
    assert.equal(order.tickets, undefined);
    assert.deepEqual(DELIVERY_RESPONSE_SELECT.driver.select, { id: true, name: true });
  });

  it('keeps address and ticket evidence in the driver response', () => {
    const order = DELIVERY_DRIVER_RESPONSE_SELECT.order.select;
    assert.equal(order.shippingAddress, true);
    assert.ok(order.tickets.select.thumbnailUrl);
    assert.ok(order.tickets.select.imageUrl);
  });
});
