// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';

/**
 * The board across days against PostgreSQL: earlier orders that never went
 * out carry over to today, later ones are counted ahead, undated ones are
 * listed apart, and a past day is a record rather than a workspace.
 *
 * "Today" is passed in as 2026-08-15, the morning after the sample reports.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';
const TODAY = '2026-08-15';

async function resetDatabase(): Promise<void> {
  if (!disposableConfirmed) {
    throw new Error('Refusing to clear a database without SPRUCE_TEST_CONFIRM_DISPOSABLE=1');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "OrderDocument", "Order", "Driver", "Delivery" RESTART IDENTITY CASCADE'
  );
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** A synthetic order with one product line. Every value is invented. */
async function seedOrder(
  documentNumber: string,
  deliveryDate: string | null,
  options: { isPickup?: boolean; customerName?: string; flags?: string[] } = {},
) {
  const document = await prisma.orderDocument.create({
    data: {
      documentNumber,
      customerName: options.customerName ?? `Customer ${documentNumber}`,
      deliveryDate: deliveryDate ? day(deliveryDate) : null,
      isPickup: options.isPickup ?? false,
      flags: options.flags ?? [],
      shippingAddress: '1 Example St, Cambridge',
    },
  });
  await prisma.order.create({
    data: {
      spruceOrderId: `${documentNumber}-L1`,
      documentId: document.id,
      lineNumber: 1,
      spruceItemNumber: 'AGG01',
      customerName: document.customerName,
      product: 'Type 1 (MT)',
      quantity: '12',
      unit: 'MT',
      orderDate: day('2026-08-10'),
    },
  });
  return document;
}

let driverCount = 0;
const seedDriver = (name: string) =>
  prisma.driver.create({ data: { name, phone: `519-555-${String(++driverCount).padStart(4, '0')}` } });

async function finish(documentId: string, driverId: string, status: 'DELIVERED' | 'CANCELLED', completedAt: Date) {
  const stop = await DispatchService.assignOrder(documentId, driverId);
  await prisma.delivery.update({ where: { id: stop.id }, data: { status, completedAt } });
  return stop;
}

const numbers = (rows: Array<{ spruceOrderId: string }>) => rows.map(row => row.spruceOrderId);

describe('the board across days (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  beforeEach(resetDatabase);

  after(async () => {
    await prisma.$disconnect();
  });

  it('carries over earlier orders that never went out, and only on today', async () => {
    const driver = await seedDriver('Driver');
    await seedOrder('9900-000001', '2026-08-14'); // never dispatched
    const onRun = await seedOrder('9900-000002', '2026-08-14'); // still on a driver's run
    const delivered = await seedOrder('9900-000003', '2026-08-14');
    const cancelled = await seedOrder('9900-000004', '2026-08-14');
    const takenBack = await seedOrder('9900-000005', '2026-08-14'); // dispatched, then unassigned
    await seedOrder('9900-000006', '2026-08-13'); // older still
    await seedOrder('9900-000007', TODAY);
    await seedOrder('9900-000008', '2026-08-17');
    await seedOrder('9900-000009', null, { isPickup: true });
    await seedOrder('9900-000010', '2026-08-14', { isPickup: true });
    // Invoiced, closed or voided in Spruce since: never carried over.
    await seedOrder('9900-000011', '2026-08-14', { flags: ['NOT_OPEN'] });
    const closedTakenBack = await seedOrder('9900-000012', '2026-08-13', { flags: ['NO_ADDRESS', 'NOT_OPEN'] });

    await DispatchService.assignOrder(onRun.id, driver.id);
    await finish(delivered.id, driver.id, 'DELIVERED', new Date('2026-08-14T16:00:00Z'));
    await finish(cancelled.id, driver.id, 'CANCELLED', new Date('2026-08-14T16:00:00Z'));
    await DispatchService.assignOrder(takenBack.id, driver.id);
    await DispatchService.unassignOrder(takenBack.id);
    await DispatchService.assignOrder(closedTakenBack.id, driver.id);
    await DispatchService.unassignOrder(closedTakenBack.id);

    const today = await DispatchService.getDispatchBoard(TODAY, TODAY);
    assert.equal(today.readOnly, false);
    // Oldest first, with the date each was due.
    assert.deepEqual(numbers(today.carriedOver), ['9900-000006', '9900-000001', '9900-000005']);
    assert.equal(today.carriedOver[0]!.deliveryDate?.toISOString(), '2026-08-13T00:00:00.000Z');
    assert.deepEqual(numbers(today.unassignedOrders), ['9900-000007']);
    // The one still on a run is shown there, once.
    const run = today.drivers.find(row => row.id === driver.id)!.deliveries;
    assert.deepEqual(run.map(stop => stop.order.spruceOrderId), ['9900-000002']);

    // Any other day has nothing carried over.
    assert.deepEqual((await DispatchService.getDispatchBoard('2026-08-14', TODAY)).carriedOver, []);
    assert.deepEqual((await DispatchService.getDispatchBoard('2026-08-17', TODAY)).carriedOver, []);
  });

  it('makes a past day a record of that day, and leaves today and later open', async () => {
    const driver = await seedDriver('Driver');
    const due = await seedOrder('9900-000001', '2026-08-14');
    const done = await seedOrder('9900-000002', '2026-08-14');
    const todays = await seedOrder('9900-000003', TODAY);
    await seedOrder('9900-000004', '2026-08-14');

    await DispatchService.assignOrder(due.id, driver.id);
    // 12:00 in Cambridge on the 14th.
    await finish(done.id, driver.id, 'DELIVERED', new Date('2026-08-14T16:00:00Z'));
    await DispatchService.assignOrder(todays.id, driver.id);

    const past = await DispatchService.getDispatchBoard('2026-08-14', TODAY);
    assert.equal(past.readOnly, true);
    // What was due or finished that day; today's stop is not part of it.
    const pastRun = past.drivers.find(row => row.id === driver.id)!.deliveries;
    assert.deepEqual(pastRun.map(stop => stop.order.spruceOrderId).sort(), ['9900-000001', '9900-000002']);
    assert.deepEqual(numbers(past.unassignedOrders), ['9900-000004']);

    const today = await DispatchService.getDispatchBoard(TODAY, TODAY);
    const todayRun = today.drivers.find(row => row.id === driver.id)!.deliveries;
    // Open work shows on today whatever day it was due; finished work does not.
    assert.deepEqual(todayRun.map(stop => stop.order.spruceOrderId).sort(), ['9900-000001', '9900-000003']);

    assert.equal((await DispatchService.getDispatchBoard('2026-08-17', TODAY)).readOnly, false);
  });

  it('counts the days ahead, and how many of each still need a driver', async () => {
    const driver = await seedDriver('Driver');
    const assigned = await seedOrder('9900-000001', '2026-08-17');
    await seedOrder('9900-000002', '2026-08-17');
    await seedOrder('9900-000003', '2026-08-19');
    await seedOrder('9900-000004', '2026-08-31');
    await seedOrder('9900-000005', TODAY);
    await seedOrder('9900-000006', '2026-08-14');
    await seedOrder('9900-000007', null, { isPickup: true });
    await DispatchService.assignOrder(assigned.id, driver.id);

    assert.deepEqual(await DispatchService.getUpcoming(TODAY), [
      { date: '2026-08-17', count: 2, unassigned: 1 },
      { date: '2026-08-19', count: 1, unassigned: 1 },
      { date: '2026-08-31', count: 1, unassigned: 1 },
    ]);
  });

  it('lists open pickups and open undated deliveries, never dated or closed orders, and searches them', async () => {
    await seedOrder('9900-000001', null, { isPickup: true, customerName: 'Pat Example' });
    await seedOrder('9900-000002', null, { isPickup: true, customerName: 'Sam Sample' });
    // Pickups Spruce no longer lists as open, undated or dated.
    await seedOrder('9900-000007', null, { isPickup: true, flags: ['NOT_OPEN'] });
    await seedOrder('9900-000008', '2026-08-12', { isPickup: true, customerName: 'Pat Closed', flags: ['NOT_OPEN'] });
    await seedOrder('9900-000003', null); // a delivery with no date yet
    const closed = await seedOrder('9900-000006', null); // invoiced or voided in Spruce since
    await prisma.orderDocument.update({ where: { id: closed.id }, data: { flags: ['NOT_OPEN'] } });
    await seedOrder('9900-000004', TODAY);
    await seedOrder('9900-000005', '2026-08-17');

    const all = await DispatchService.getUndatedOrders();
    assert.deepEqual(numbers(all), ['9900-000003', '9900-000002', '9900-000001']);
    assert.deepEqual(all.map(row => row.isPickup), [false, true, true]);
    assert.equal(all[0]!.wholeOrder, true);
    for (const key of ['unitPrice', 'unitCost', 'poValue', 'totalWithTax', 'remaining', 'grossMarginPct', 'supplier']) {
      assert.equal(JSON.stringify(all).includes(`"${key}"`), false, key);
    }

    assert.deepEqual(numbers(await DispatchService.getUndatedOrders('000002')), ['9900-000002']);
    assert.deepEqual(numbers(await DispatchService.getUndatedOrders('pat ex')), ['9900-000001']);
    assert.deepEqual(await DispatchService.getUndatedOrders('9900-000004'), []);
    // A search does not bring a closed pickup back.
    assert.deepEqual(await DispatchService.getUndatedOrders('Pat Closed'), []);
    assert.deepEqual(await DispatchService.getUndatedOrders('9900-000007'), []);
  });

  it('refuses to change a finished past order, and keeps an unfinished one assignable', async () => {
    const driver = await seedDriver('Driver');
    const other = await seedDriver('Other');
    const delivered = await seedOrder('9900-000001', '2026-08-14');
    const left = await seedOrder('9900-000002', '2026-08-14');
    await finish(delivered.id, driver.id, 'DELIVERED', new Date('2026-08-14T16:00:00Z'));

    await assert.rejects(DispatchService.assignOrder(delivered.id, other.id), (err: any) =>
      err.status === 409 && /already delivered/.test(err.message));
    await assert.rejects(DispatchService.unassignOrder(delivered.id), (err: any) => err.status === 409);

    // Carried over: given to a driver today, then taken back.
    await DispatchService.assignOrder(left.id, driver.id);
    let today = await DispatchService.getDispatchBoard(TODAY, TODAY);
    assert.deepEqual(numbers(today.carriedOver), []);
    await DispatchService.assignOrder(left.id, other.id);
    await DispatchService.unassignOrder(left.id);
    today = await DispatchService.getDispatchBoard(TODAY, TODAY);
    assert.deepEqual(numbers(today.carriedOver), ['9900-000002']);
    assert.equal(await prisma.delivery.count({ where: { documentId: left.id } }), 1);
  });
});
