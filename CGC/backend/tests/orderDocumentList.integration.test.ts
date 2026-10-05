import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { listOrders } from '../src/modules/orders/orderList.service.js';
import { businessDayOf } from '../src/lib/businessDay.js';

/**
 * The Orders page's list of whole orders, against a real database.
 *
 * One row per Spruce order however many lines it has; an order refreshed by
 * today's upload listed under today; the delivery-status filter combined with
 * a range of upload days; and the row carrying what the import found missing.
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

const USER_ID = '66666666-6666-4666-8666-6666666666a1';
const DRIVER_ID = '66666666-6666-4666-8666-6666666666d1';
const TODAY_BATCH = '66666666-6666-4666-8666-6666666666b1';
const OCT_7 = new Date('2026-10-07T15:00:00Z');
const OCT_9 = new Date('2026-10-09T15:00:00Z');
const AUGUST = new Date('2026-08-14T15:00:00Z');

const today = businessDayOf();

const line = (number: string, n: number, product: string, extra: Record<string, unknown> = {}) => ({
  spruceOrderId: `${number}-${n}`, lineNumber: n, customerName: 'x', product, lineClass: 'PRODUCT', ...extra,
});

async function seed() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Delivery", "Order", "OrderDocument", "ImportBatch", "Driver", "User" RESTART IDENTITY CASCADE'
  );
  await prisma.user.create({
    data: { id: USER_ID, name: 'Test Admin', email: 'doclist@example.test', passwordHash: 'x', role: 'ADMIN' },
  });
  await prisma.driver.create({ data: { id: DRIVER_ID, name: 'Alex', phone: '555-0199' } });
  await prisma.importBatch.create({
    data: { id: TODAY_BATCH, dispatchDate: new Date(`${today}T00:00:00Z`), status: 'DONE', createdById: USER_ID },
  });

  // Three lines, first imported in August, described again by today's upload,
  // no address: one row, under today, marked.
  await prisma.orderDocument.create({
    data: {
      documentNumber: '2610-100001', customerName: 'Maple Ridge', createdAt: AUGUST, lastBatchId: TODAY_BATCH,
      flags: ['NO_ADDRESS'], poNumber: 'PO-1',
      lines: { create: [line('2610-100001', 1, 'Soil', { createdAt: AUGUST }), line('2610-100001', 2, 'Mulch', { createdAt: AUGUST, poNumber: 'PO-2', hasInvoice: true }), line('2610-100001', 3, 'Sand', { createdAt: AUGUST })] },
    },
  });
  // Uploaded Oct 7, on a driver's run.
  const assigned = await prisma.orderDocument.create({
    data: {
      documentNumber: '2610-100002', customerName: 'Riverside', createdAt: OCT_7, shippingAddress: '1 River Rd',
      lines: { create: [line('2610-100002', 1, 'Pavers', { createdAt: OCT_7 })] },
    },
    include: { lines: true },
  });
  await prisma.delivery.create({
    data: { orderId: assigned.lines[0]!.id, documentId: assigned.id, driverId: DRIVER_ID, status: 'PLACED' },
  });
  // Uploaded Oct 9, delivered.
  const delivered = await prisma.orderDocument.create({
    data: {
      documentNumber: '2610-100003', customerName: 'Elm Street', createdAt: OCT_9, shippingAddress: '7 Elm St',
      lines: { create: [line('2610-100003', 1, 'Gravel', { createdAt: OCT_9 })] },
    },
    include: { lines: true },
  });
  await prisma.delivery.create({
    data: { orderId: delivered.lines[0]!.id, documentId: delivered.id, driverId: DRIVER_ID, status: 'DELIVERED' },
  });
  // A pickup, uploaded Oct 9.
  await prisma.orderDocument.create({
    data: {
      documentNumber: '2610-100004', customerName: 'Walk-in', createdAt: OCT_9, isPickup: true,
      lines: { create: [line('2610-100004', 1, 'Bagged Mulch', { createdAt: OCT_9 })] },
    },
  });
}

const numbers = async (filters: Record<string, unknown>) =>
  (await listOrders(filters)).data.map(row => row.spruceOrderId);

describe('Orders list of whole orders', { skip: !runnable && 'needs CGC_TEST_CONFIRM_DISPOSABLE=1 and a loopback DATABASE_URL' }, () => {
  before(seed);
  after(() => prisma.$disconnect());

  it('lists one row per order, newest number first, however many lines it has', async () => {
    assert.deepEqual(await numbers({}), ['2610-100004', '2610-100003', '2610-100002', '2610-100001']);
  });

  it('lists an order refreshed by today\'s upload under today', async () => {
    assert.deepEqual(await numbers({ uploadStartDate: today, uploadEndDate: today }), ['2610-100001']);
  });

  it('takes a range of upload days and a delivery status together', async () => {
    const range = { uploadStartDate: '2026-10-07', uploadEndDate: '2026-10-10' };
    assert.deepEqual(await numbers(range), ['2610-100004', '2610-100003', '2610-100002']);
    assert.deepEqual(await numbers({ ...range, deliveryStatus: 'pending' }), ['2610-100004', '2610-100002']);
    assert.deepEqual(await numbers({ ...range, deliveryStatus: 'delivered' }), ['2610-100003']);
    assert.deepEqual(await numbers({ ...range, deliveryStatus: 'assigned' }), ['2610-100002']);
    assert.deepEqual(await numbers({ ...range, deliveryStatus: 'unassigned' }), ['2610-100004']);
  });

  it('separates pickups from deliveries', async () => {
    assert.deepEqual(await numbers({ fulfilment: 'pickup' }), ['2610-100004']);
    assert.deepEqual(await numbers({ fulfilment: 'delivery', deliveryStatus: 'pending' }), ['2610-100002', '2610-100001']);
  });

  it('finds an order by a product on any of its lines', async () => {
    assert.deepEqual(await numbers({ search: 'mulch' }), ['2610-100004', '2610-100001']);
  });

  it('carries what is missing, the stop, the POs and the invoiced lines', async () => {
    const [refreshed] = (await listOrders({ uploadStartDate: today, uploadEndDate: today })).data;
    assert.deepEqual(refreshed?.flags, ['NO_ADDRESS']);
    assert.equal(refreshed?.delivery, null);
    assert.deepEqual(refreshed?.poNumbers, ['PO-1', 'PO-2']);
    assert.equal(refreshed?.invoicedLines, 1);
    assert.equal(refreshed?.lineCount, 3);

    const [onRun] = (await listOrders({ deliveryStatus: 'assigned' })).data;
    assert.deepEqual(onRun?.delivery, { status: 'PLACED', driverName: 'Alex' });
  });

  it('counts what it lists, and never sends a price', async () => {
    const result = await listOrders({ uploadStartDate: '2026-10-07', uploadEndDate: '2026-10-10', deliveryStatus: 'pending' });
    assert.equal(result.pagination.total, result.data.length);
    const text = JSON.stringify(result.data);
    for (const key of ['unitPrice', 'unitCost', 'totalWithTax', 'grossMarginPct']) assert.equal(text.includes(key), false, key);
  });

  it('rejects an unknown status or a backwards range rather than listing everything', async () => {
    await assert.rejects(listOrders({ deliveryStatus: 'lost' }), (err: any) => err.status === 400);
    await assert.rejects(listOrders({ uploadStartDate: '2026-10-10', uploadEndDate: '2026-10-07' }), (err: any) => err.status === 400);
  });
});
