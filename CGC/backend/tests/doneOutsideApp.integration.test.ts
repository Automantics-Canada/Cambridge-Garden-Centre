// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';

import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { businessDayOf } from '../src/lib/businessDay.js';
import { DONE_OUTSIDE_APP_NOTE } from '../src/modules/dispatch/doneOutsideApp.service.js';
import { runImportBatch } from '../src/modules/orders/import/importBatch.service.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import type { ParsedSpruceReport, ParsedSpruceRow, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
import { deliveryReport, itemTrackingReport, orderSummaryReport } from './fixtures/spruceLayouts.js';

/**
 * Orders delivered without the app, against PostgreSQL through the HTTP API
 * (client answers, Oct 2026).
 *
 * An undated order charged for delivery, on no Deliveries report, was most
 * likely delivered already: the import makes it a delivery, the board keeps
 * it apart from the day's real work, and the office can mark it done outside
 * the app, after which no list offers it again. Office roles only; marking
 * twice changes nothing.
 *
 * Every name, number and address here is invented.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();
const runnable = confirmed && loopback;

let server: Server;
let baseUrl: string;
const tokens: Record<'AP_USER' | 'OWNER' | 'ADMIN' | 'DRIVER', string> = { AP_USER: '', OWNER: '', ADMIN: '', DRIVER: '' };
let officeUserId: string;

async function api(method: string, path: string, token = tokens.AP_USER) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const markDone = (documentId: string, token = tokens.AP_USER) =>
  api('POST', `/api/dispatch/orders/${documentId}/done-outside-app`, token);

const day = (offset: number) => {
  const date = new Date(`${businessDayOf()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
};

/** An order with one product, made directly; `deliveryDate` null for undated. */
async function seedOrder(documentNumber: string, deliveryDate: Date | null, extra: Record<string, unknown> = {}) {
  const document = await prisma.orderDocument.create({
    data: { documentNumber, customerName: 'Example Customer', deliveryDate, shippingAddress: '1 Example St, Cambridge', ...extra },
  });
  await prisma.order.create({
    data: {
      spruceOrderId: `${documentNumber}-L1`,
      documentId: document.id,
      lineNumber: 1,
      customerName: 'Example Customer',
      product: 'Example Soil',
      quantity: '2',
      spruceItemNumber: 'SOILGRDNA',
      lineClass: 'PRODUCT',
    },
  });
  return document;
}

const board = async () => (await api('GET', `/api/dispatch?date=${businessDayOf()}`)).body;
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);

describe('done outside the app (PostgreSQL)', { skip: !runnable }, () => {
  before(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    for (const role of ['AP_USER', 'OWNER', 'ADMIN', 'DRIVER'] as const) {
      const user = await prisma.user.create({
        data: { name: role, email: `${role.toLowerCase()}-done@example.invalid`, passwordHash: 'x', role },
      });
      if (role === 'AP_USER') officeUserId = user.id;
      tokens[role] = jwt.sign({ id: user.id, email: user.email, role }, env.jwtSecret);
    }
    const { default: app } = await import('../src/app.js');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ImportBatch", "OrderDocument", "Order", "Delivery", "DeliveryHistory", "Driver", "AuditLog" RESTART IDENTITY CASCADE'
    );
  });

  after(async () => {
    server?.close();
    await prisma.$disconnect();
  });

  it('imports an undated order charged for a slinger as a delivery, kept apart on today\'s board', async () => {
    // 721442's shape: a product and an unlisted slinger charge, open on the
    // Order report, with no date and no SCH, and on no Deliveries report.
    const undated = (report: ParsedSpruceReport, extra: Partial<ParsedSpruceRow> = {}): ParsedSpruceReport => {
      const order = report.rows
        .filter(row => row.documentNumber === '2608-700001')
        .slice(0, 1)
        .map(row => ({ ...row, documentNumber: '2608-700501', deliveryDateRaw: undefined, deliveryFlag: undefined, poNumber: undefined, vendorName: undefined, ...extra }));
      return {
        ...report,
        rows: [...report.rows, ...order, ...order.map(row => ({ ...row, itemNumber: 'MISCDELE', product: 'Slinger Delivery Standard', quantity: 1 }))],
      };
    };
    const reports: Record<SpruceReportType, ParsedSpruceReport> = {
      ORDER_SUMMARY: undated(parseSprucePages(orderSummaryReport())),
      DELIVERY: parseSprucePages(deliveryReport()),
      ITEM_TRACKING: undated(parseSprucePages(itemTrackingReport())),
    };
    await runImportBatch(prisma, {
      dispatchDate: businessDayOf(),
      createdById: officeUserId,
      files: (Object.keys(reports) as SpruceReportType[]).map(reportType => ({
        reportType,
        fileName: `${reportType}.pdf`,
        buffer: Buffer.from(`undated-slinger-${reportType}`),
        report: reports[reportType],
      })),
    });

    const stored = await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber: '2608-700501' } });
    assert.equal(stored.isPickup, false, 'any delivery charge makes it a delivery');
    assert.equal(stored.deliveryType, 'SLINGER', 'read from the description of an unlisted code');

    const today = await board();
    const row = today.unassignedOrders.find((candidate: { id: string }) => candidate.id === stored.id);
    assert.ok(row, 'still on today\'s board, as today\'s upload');
    assert.equal(row.likelyDelivered, true);
    assert.ok(row.fulfilment.checks.includes('NOT_ON_DELIVERIES_REPORT'));
  });

  it('marks an order with no stop delivered: a stop, its history and an audit row; once only', async () => {
    const order = await seedOrder('9900-000601', null, { isPickup: false });
    assert.ok(ids((await board()).unassignedOrders).includes(order.id), 'in today\'s pool first');

    const first = await markDone(order.id);
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, true);
    const stop = await prisma.delivery.findUniqueOrThrow({ where: { documentId: order.id }, include: { history: true } });
    assert.equal(stop.status, 'DELIVERED');
    assert.ok(stop.completedAt);
    assert.equal(stop.driverId, null);
    assert.deepEqual(stop.history.map(entry => [entry.status, entry.notes]), [['DELIVERED', DONE_OUTSIDE_APP_NOTE]]);
    const audit = await prisma.auditLog.findMany({ where: { entityId: order.id } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actionType, 'ORDER_EDITED');
    assert.equal(audit[0]!.performedById, officeUserId);
    assert.equal((audit[0]!.details as { action: string }).action, 'DONE_OUTSIDE_APP');

    // Again, by another office role: nothing new.
    const again = await markDone(order.id, tokens.OWNER);
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false);
    assert.equal(await prisma.deliveryHistory.count({ where: { deliveryId: stop.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: order.id } }), 1);

    // Off every list that offered it.
    assert.equal(ids((await board()).unassignedOrders).includes(order.id), false);
    assert.equal(ids((await api('GET', '/api/dispatch/pickups')).body).includes(order.id), false);
  });

  it('clears a carried-over order and today\'s assigned one, keeping its driver', async () => {
    // Imported on an earlier day, so not today's upload.
    const carried = await seedOrder('9900-000602', day(-3), { createdAt: day(-4) });
    assert.ok(ids((await board()).carriedOver).includes(carried.id));
    assert.equal((await markDone(carried.id, tokens.ADMIN)).status, 200);
    assert.equal(ids((await board()).carriedOver).includes(carried.id), false);

    const driver = await prisma.driver.create({ data: { name: 'Example Driver', phone: '519-555-0602' } });
    const assigned = await seedOrder('9900-000603', day(0));
    const line = await prisma.order.findFirstOrThrow({ where: { documentId: assigned.id } });
    await prisma.delivery.create({ data: { documentId: assigned.id, orderId: line.id, driverId: driver.id, status: 'PLACED' } });
    assert.equal((await markDone(assigned.id)).status, 200);
    const stop = await prisma.delivery.findUniqueOrThrow({ where: { documentId: assigned.id } });
    assert.equal(stop.status, 'DELIVERED');
    assert.equal(stop.driverId, driver.id);
  });

  it('leaves a stop on a truck to its driver, a cancelled one cancelled, and refuses a driver', async () => {
    const driver = await prisma.driver.create({ data: { name: 'Example Driver', phone: '519-555-0604' } });
    const onTruck = await seedOrder('9900-000604', day(0));
    const cancelled = await seedOrder('9900-000605', day(0));
    for (const [document, status] of [[onTruck, 'IN_TRANSIT'], [cancelled, 'CANCELLED']] as const) {
      const line = await prisma.order.findFirstOrThrow({ where: { documentId: document.id } });
      await prisma.delivery.create({ data: { documentId: document.id, orderId: line.id, driverId: driver.id, status } });
    }
    assert.equal((await markDone(onTruck.id)).status, 409);
    assert.equal((await markDone(cancelled.id)).status, 409);

    const waiting = await seedOrder('9900-000606', null, { isPickup: false });
    const refused = await markDone(waiting.id, tokens.DRIVER);
    assert.equal(refused.status, 403);
    assert.equal(await prisma.delivery.count({ where: { documentId: waiting.id } }), 0, 'nothing written');

    assert.equal((await markDone('00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await markDone('not-an-id')).status, 404);
  });
});
