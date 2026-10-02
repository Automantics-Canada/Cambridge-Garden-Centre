// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { DeliveriesService, DeliveryNotCurrentError } from '../src/modules/deliveries/deliveries.service.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { DriverService } from '../src/modules/drivers/driver.service.js';

/**
 * A driver's phone against PostgreSQL: one stop at a time, the one dispatch
 * put first, with the whole order on it and nothing about money.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

/** A synthetic order with two products and a skid deposit, given to `driverId`. */
async function seedStop(documentNumber: string, driverId: string, deliveryDate = '2026-09-02') {
  const document = await prisma.orderDocument.create({
    data: {
      documentNumber,
      customerName: `Customer ${documentNumber}`,
      deliveryDate: new Date(deliveryDate),
      shippingAddress: '1 Example St, Cambridge',
      addressNormalized: '1 Example St, Cambridge',
      phone: '519-555-0100',
      deliveryInstructions: 'CALL BEFORE ARRIVAL',
      dispatcherNotes: 'Gate code 4411',
      deliveryType: 'SLINGER',
      totalWithTax: '575.08',
    },
  });
  const lines = [];
  for (const [index, [code, product, quantity, unit, lineClass]] of [
    ['AGG3/4C', 'Clear Stone', '12', 'MT', 'PRODUCT'],
    ['PSSBL', 'Polymeric Sand', '2', 'BAG', 'PRODUCT'],
    ['RSKID', 'Skid Deposit', '1', 'EA', 'DEPOSIT'],
  ].entries()) {
    lines.push(await prisma.order.create({
      data: {
        spruceOrderId: `${documentNumber}-L${index + 1}`,
        documentId: document.id,
        lineNumber: index + 1,
        spruceItemNumber: code,
        lineClass,
        customerName: document.customerName,
        product: product!,
        quantity: quantity!,
        unit,
        unitPrice: '35.91',
        unitCost: '16.50',
        orderDate: new Date('2026-09-01'),
      },
    }));
  }
  await DispatchService.assignOrder(document.id, driverId);
  return prisma.delivery.findUniqueOrThrow({ where: { documentId: document.id } });
}

const MONEY = /"(unitPrice|unitCost|poValue|totalWithTax|remaining|remainingDeposit|grossMarginPct|supplier)"/;

describe('a driver\'s current stop (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let userId: string;
  let driverId: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "OrderDocument", "Order", "Driver", "User", "Delivery" RESTART IDENTITY CASCADE'
    );
    userId = (await prisma.user.create({
      data: { name: 'Driver', email: 'driver-stop@example.test', passwordHash: 'x', role: 'DRIVER' },
    })).id;
    driverId = (await prisma.driver.create({ data: { name: 'Driver', phone: '519-555-0300', userId } })).id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('answers with the first stop dispatch set, the whole order on it, and how many remain', async () => {
    const first = await seedStop('9900-000001', driverId);
    await seedStop('9900-000002', driverId);
    await seedStop('9900-000003', driverId);

    const answer = await DeliveriesService.getCurrentStop(driverId);

    assert.equal(answer.data.length, 1, 'never the rest of the run');
    assert.equal(answer.pagination.totalCount, 3);
    const stop = answer.data[0]!;
    assert.equal(stop.id, first.id);
    assert.equal(stop.document?.documentNumber, '9900-000001');
    assert.equal(stop.document?.dispatcherNotes, 'Gate code 4411');
    assert.equal(stop.document?.phone, '519-555-0100');
    assert.deepEqual(stop.document?.lines.map(line => line.product), ['Clear Stone', 'Polymeric Sand', 'Skid Deposit']);
    assert.doesNotMatch(JSON.stringify(answer), MONEY, 'nothing about money reaches the phone');
  });

  it('follows dispatch when the run is reordered, and moves on when a stop is done', async () => {
    const first = await seedStop('9900-000001', driverId);
    const second = await seedStop('9900-000002', driverId);
    const third = await seedStop('9900-000003', driverId);

    // A customer called: the third order jumps the queue.
    await DispatchService.reorderDeliveries(driverId, [third.id, first.id, second.id]);
    assert.equal((await DeliveriesService.getCurrentStop(driverId)).data[0]!.id, third.id);

    await prisma.delivery.update({ where: { id: third.id }, data: { status: 'DELIVERED', completedAt: new Date() } });
    const next = await DeliveriesService.getCurrentStop(driverId);
    assert.equal(next.data[0]!.id, first.id);
    assert.equal(next.pagination.totalCount, 2);
  });

  it('keeps a stop the driver has started on screen when dispatch reorders the run', async () => {
    const first = await seedStop('9900-000001', driverId);
    const second = await seedStop('9900-000002', driverId);
    await prisma.delivery.update({ where: { id: first.id }, data: { status: 'IN_TRANSIT' } });

    // A customer calls and dispatch puts their order first.
    await DispatchService.reorderDeliveries(driverId, [second.id, first.id]);

    assert.equal((await DeliveriesService.getCurrentStop(driverId)).data[0]!.id, first.id, 'the loaded truck finishes its stop');
    await assert.rejects(DeliveriesService.assertCurrentStop(driverId, second.id), DeliveryNotCurrentError);

    await prisma.delivery.update({ where: { id: first.id }, data: { status: 'DELIVERED', completedAt: new Date() } });
    assert.equal((await DeliveriesService.getCurrentStop(driverId)).data[0]!.id, second.id, 'then dispatch\'s order applies');
  });

  it('keeps an order assigned ahead off the phone until its day', async () => {
    // Dispatch pre-assigns the 9/04 order on 9/02, and puts it first.
    const later = await seedStop('9900-000001', driverId, '2026-09-04');
    const today = await seedStop('9900-000002', driverId, '2026-09-02');
    await DispatchService.reorderDeliveries(driverId, [later.id, today.id]);

    const onTheDay = await DeliveriesService.getCurrentStop(driverId, '2026-09-02');
    assert.equal(onTheDay.data[0]!.id, today.id, "today's order, not the one assigned ahead");
    assert.equal(onTheDay.pagination.totalCount, 1, 'a later day does not count as remaining');
    await assert.rejects(DeliveriesService.assertCurrentStop(driverId, later.id, '2026-09-02'), DeliveryNotCurrentError);

    await prisma.delivery.update({ where: { id: today.id }, data: { status: 'DELIVERED', completedAt: new Date() } });
    const nothingYet = await DeliveriesService.getCurrentStop(driverId, '2026-09-03');
    assert.deepEqual(nothingYet.data, [], 'nothing due on 9/03');
    assert.equal(nothingYet.pagination.totalCount, 0);

    const itsDay = await DeliveriesService.getCurrentStop(driverId, '2026-09-04');
    assert.equal(itsDay.data[0]!.id, later.id, 'it reaches the phone on its day');
  });

  it('still offers an order carried over from an earlier day', async () => {
    const overdue = await seedStop('9900-000001', driverId, '2026-09-01');
    assert.equal((await DeliveriesService.getCurrentStop(driverId, '2026-09-02')).data[0]!.id, overdue.id);
  });

  it('refuses a change to any stop but the current one', async () => {
    const first = await seedStop('9900-000001', driverId);
    const second = await seedStop('9900-000002', driverId);

    await DeliveriesService.assertCurrentStop(driverId, first.id);
    await assert.rejects(DeliveriesService.assertCurrentStop(driverId, second.id), DeliveryNotCurrentError);
  });

  it('gives the driver\'s profile counts, never the stops themselves', async () => {
    await seedStop('9900-000001', driverId);
    await seedStop('9900-000002', driverId);

    const profile = await DriverService.getDriverByUserId(userId);

    assert.equal(profile?.name, 'Driver');
    assert.equal(profile?.stats.totalToday, 2);
    assert.equal('deliveries' in (profile ?? {}), false);
    assert.equal('currentTask' in (profile ?? {}), false);
    assert.doesNotMatch(JSON.stringify(profile), /9900-00000|Customer|Example St/);
  });
});
