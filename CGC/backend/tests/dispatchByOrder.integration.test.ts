// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { DeliveriesService } from '../src/modules/deliveries/deliveries.service.js';
import { parseDeliveryQuery } from '../src/modules/deliveries/deliveryQuery.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';

/**
 * Dispatching whole Spruce orders against PostgreSQL: the pool is the day's
 * orders by delivery date, a driver is given an order not a line, and an
 * order has one stop wherever it moves.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

async function resetDatabase(): Promise<void> {
  if (!disposableConfirmed) {
    throw new Error('Refusing to clear a database without SPRUCE_TEST_CONFIRM_DISPOSABLE=1');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "OrderDocument", "Order", "Driver", "Delivery" RESTART IDENTITY CASCADE'
  );
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** A synthetic order with a product line and a delivery charge. */
async function seedOrder(documentNumber: string, overrides: { deliveryDate?: Date | null; isPickup?: boolean } = {}) {
  const document = await prisma.orderDocument.create({
    data: {
      documentNumber,
      customerName: `Customer ${documentNumber}`,
      deliveryDate: overrides.deliveryDate === undefined ? day('2026-09-02') : overrides.deliveryDate,
      isPickup: overrides.isPickup ?? false,
      shippingAddress: '1 Example St, Cambridge',
      flags: ['CUSTOMER_ON_SITE'],
    },
  });
  for (const [index, line] of [
    { code: 'MISCDEL', product: 'Delivery Charge', quantity: '1', unit: 'EA' },
    { code: 'AGG01', product: 'Type 1 (MT)', quantity: '40', unit: 'MT' },
    { code: 'AGG01', product: 'Type 1 (MT)', quantity: '40', unit: 'MT' },
  ].entries()) {
    await prisma.order.create({
      data: {
        spruceOrderId: `${documentNumber}-L${index + 1}`,
        documentId: document.id,
        lineNumber: index + 1,
        spruceItemNumber: line.code,
        customerName: document.customerName,
        product: line.product,
        quantity: line.quantity,
        unit: line.unit,
        orderDate: day('2026-09-01'),
      },
    });
  }
  return document;
}

const seedDriver = (name: string, phone: string) => prisma.driver.create({ data: { name, phone } });

describe('dispatching whole orders (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  beforeEach(resetDatabase);

  after(async () => {
    await prisma.$disconnect();
  });

  it('pools the day\'s orders by delivery date, never pickups or other days', async () => {
    const today = await seedOrder('9900-000001');
    await seedOrder('9900-000002', { deliveryDate: day('2026-09-03') });
    await seedOrder('9900-000003', { deliveryDate: null, isPickup: true });

    const board = await DispatchService.getDispatchBoard('2026-09-02');

    assert.deepEqual(board.unassignedOrders.map(order => order.id), [today.id]);
    const [row] = board.unassignedOrders;
    assert.equal(row!.spruceOrderId, '9900-000001');
    assert.equal(row!.quantity, 80, 'two 40 MT loads');
    assert.equal(row!.lines.length, 2, 'the delivery charge is not on the truck');
    assert.deepEqual(row!.flags, ['CUSTOMER_ON_SITE']);
  });

  it('gives a driver the whole order, moves it without a second stop, and takes it back', async () => {
    const order = await seedOrder('9900-000001');
    const first = await seedDriver('First Driver', '519-555-0101');
    const second = await seedDriver('Second Driver', '519-555-0102');

    const stop = await DispatchService.assignOrder(order.id, first.id);
    let board = await DispatchService.getDispatchBoard('2026-09-02');
    assert.equal(board.unassignedOrders.length, 0);
    const run = board.drivers.find(driver => driver.id === first.id)!.deliveries;
    assert.equal(run.length, 1);
    assert.equal(run[0]!.order.wholeOrder, true);
    assert.equal(run[0]!.order.spruceOrderId, '9900-000001');
    // Every line carries the driver, which is what keeps a re-import from
    // re-pairing them by guesswork.
    const lines = await prisma.order.findMany({ where: { documentId: order.id } });
    assert.ok(lines.every(line => line.driverId === first.id));
    // The stop is filed under the first product, not the delivery charge.
    assert.equal(lines.find(line => line.id === stop.orderId)?.spruceItemNumber, 'AGG01');

    await DispatchService.assignOrder(order.id, second.id);
    assert.equal(await prisma.delivery.count(), 1, 'moving an order never makes a second stop');
    board = await DispatchService.getDispatchBoard('2026-09-02');
    assert.equal(board.drivers.find(driver => driver.id === second.id)!.deliveries.length, 1);
    assert.equal(board.drivers.find(driver => driver.id === first.id)!.deliveries.length, 0);

    await DispatchService.unassignOrder(order.id);
    board = await DispatchService.getDispatchBoard('2026-09-02');
    assert.deepEqual(board.unassignedOrders.map(row => row.id), [order.id], 'back in the pool');
    assert.ok((await prisma.order.findMany({ where: { documentId: order.id } })).every(line => line.driverId === null));
  });

  it('adds a new stop to the end of a driver\'s run', async () => {
    const driver = await seedDriver('Driver', '519-555-0103');
    const a = await seedOrder('9900-000001');
    const b = await seedOrder('9900-000002');

    assert.equal((await DispatchService.assignOrder(a.id, driver.id)).priority, 1);
    assert.equal((await DispatchService.assignOrder(b.id, driver.id)).priority, 2);
  });

  it('refuses to hand out or take back an order already delivered', async () => {
    const order = await seedOrder('9900-000001');
    const driver = await seedDriver('Driver', '519-555-0104');
    const stop = await DispatchService.assignOrder(order.id, driver.id);
    await prisma.delivery.update({ where: { id: stop.id }, data: { status: 'DELIVERED', completedAt: new Date() } });

    await assert.rejects(DispatchService.assignOrder(order.id, driver.id), (err: any) => err.status === 409);
    await assert.rejects(DispatchService.unassignOrder(order.id), (err: any) => err.status === 409);
  });

  it('lists a stop under the day its order goes out, not the day it was made', async () => {
    const order = await seedOrder('9900-000001');
    const driver = await seedDriver('Driver', '519-555-0105');
    const stop = await DispatchService.assignOrder(order.id, driver.id);
    await prisma.delivery.update({ where: { id: stop.id }, data: { createdAt: new Date('2026-08-28T15:00:00Z') } });

    const onTheDay = await DeliveriesService.getDeliveries(parseDeliveryQuery({ date: '2026-09-02' }).filters);
    const whenMade = await DeliveriesService.getDeliveries(parseDeliveryQuery({ date: '2026-08-28' }).filters);

    assert.deepEqual(onTheDay.data.map(row => row.id), [stop.id]);
    assert.equal(onTheDay.data[0]!.document?.documentNumber, '9900-000001');
    assert.equal(whenMade.data.length, 0);
  });
});
