import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { OrderService } from '../src/modules/orders/order.service.js';
import { businessDayOf } from '../src/lib/businessDay.js';

/**
 * The Orders list's upload-date and delivery-or-pickup filters, against a real
 * database.
 *
 * A re-upload of the Spruce reports updates orders in place and keeps their
 * first `createdAt`, so "uploaded today" filtered on that alone hid every
 * order the morning's upload had just refreshed. These pin that an order
 * refreshed by today's batch is listed under today, and that the new filters
 * still combine with search.
 *
 * Needs a disposable database; skips without one.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
})();
const runnable = confirmed && loopback;

const USER_ID = '77777777-7777-4777-8777-7777777777a1';
const TODAY_BATCH = '77777777-7777-4777-8777-7777777777b1';
const OLD_BATCH = '77777777-7777-4777-8777-7777777777b2';
const AUGUST = new Date('2026-08-14T15:00:00Z');

const today = businessDayOf();

async function seed() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Order", "OrderDocument", "ImportBatch", "User" RESTART IDENTITY CASCADE'
  );

  await prisma.user.create({
    data: { id: USER_ID, name: 'Test Admin', email: 'list-admin@example.test', passwordHash: 'x', role: 'ADMIN' },
  });
  await prisma.importBatch.create({
    data: { id: TODAY_BATCH, dispatchDate: new Date(`${today}T00:00:00Z`), status: 'DONE', createdById: USER_ID },
  });
  await prisma.importBatch.create({
    data: { id: OLD_BATCH, dispatchDate: new Date('2026-08-14T00:00:00Z'), status: 'DONE', createdById: USER_ID, createdAt: AUGUST },
  });

  // First imported in August; today's upload described it again.
  await prisma.orderDocument.create({
    data: {
      documentNumber: 'L-REFRESHED', customerName: 'Refreshed Landscaping', lastBatchId: TODAY_BATCH, createdAt: AUGUST,
      lines: { create: { spruceOrderId: 'L-REFRESHED-1', customerName: 'Refreshed Landscaping', product: 'Garden Soil', createdAt: AUGUST } },
    },
  });
  // Imported in August and never again.
  await prisma.orderDocument.create({
    data: {
      documentNumber: 'L-STALE', customerName: 'Stale Landscaping', lastBatchId: OLD_BATCH, createdAt: AUGUST,
      lines: { create: { spruceOrderId: 'L-STALE-1', customerName: 'Stale Landscaping', product: 'Garden Soil', createdAt: AUGUST } },
    },
  });
  // A pickup from today's upload.
  await prisma.orderDocument.create({
    data: {
      documentNumber: 'L-PICKUP', customerName: 'Walk-in Pickup', isPickup: true, lastBatchId: TODAY_BATCH,
      lines: { create: { spruceOrderId: 'L-PICKUP-1', customerName: 'Walk-in Pickup', product: 'Bagged Mulch' } },
    },
  });
  // A CSV line from before orders were grouped: no document at all.
  await prisma.order.create({
    data: { spruceOrderId: 'L-LOOSE-1', customerName: 'Loose Line Co', product: 'Sand' },
  });
}

const ids = async (filters: Record<string, unknown>) =>
  (await OrderService.getOrders(filters)).data.map(order => order.spruceOrderId).sort();

describe('Orders list filters', { skip: !runnable && 'needs CGC_TEST_CONFIRM_DISPOSABLE=1 and a loopback DATABASE_URL' }, () => {
  before(seed);
  after(() => prisma.$disconnect());

  it('lists an order refreshed by today\'s upload under today, not only the ones created today', async () => {
    assert.deepEqual(
      await ids({ uploadStartDate: today, uploadEndDate: today }),
      ['L-LOOSE-1', 'L-PICKUP-1', 'L-REFRESHED-1'],
    );
  });

  it('still lists an untouched order under the day it was imported', async () => {
    assert.deepEqual(
      await ids({ uploadStartDate: '2026-08-14', uploadEndDate: '2026-08-14' }),
      ['L-REFRESHED-1', 'L-STALE-1'],
    );
  });

  it('keeps search and the upload date together', async () => {
    assert.deepEqual(await ids({ uploadStartDate: today, uploadEndDate: today, search: 'landscaping' }), ['L-REFRESHED-1']);
  });

  it('separates pickups from deliveries, counting a line with no order as a delivery', async () => {
    assert.deepEqual(await ids({ fulfilment: 'pickup' }), ['L-PICKUP-1']);
    assert.deepEqual(await ids({ fulfilment: 'delivery' }), ['L-LOOSE-1', 'L-REFRESHED-1', 'L-STALE-1']);
    assert.deepEqual(await ids({ fulfilment: 'delivery', uploadStartDate: today, uploadEndDate: today }), ['L-LOOSE-1', 'L-REFRESHED-1']);
  });

  it('counts what it lists', async () => {
    const result = await OrderService.getOrders({ fulfilment: 'delivery', uploadStartDate: today, uploadEndDate: today });
    assert.equal(result.pagination.total, result.data.length);
  });

  it('sends the order id and pickup flag the page needs', async () => {
    const [pickup] = (await OrderService.getOrders({ fulfilment: 'pickup' })).data;
    const document = await prisma.orderDocument.findUnique({ where: { documentNumber: 'L-PICKUP' } });
    assert.equal(pickup?.documentId, document?.id);
    assert.equal(pickup?.document?.isPickup, true);
  });

  it('rejects an unknown fulfilment rather than listing everything', async () => {
    await assert.rejects(OrderService.getOrders({ fulfilment: 'both' }), (err: any) => err.status === 400);
  });
});
