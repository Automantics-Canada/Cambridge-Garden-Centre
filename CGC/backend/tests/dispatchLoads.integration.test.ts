// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import jwt from 'jsonwebtoken';

import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { businessDayOf } from '../src/lib/businessDay.js';

/**
 * Dispatch loads and their haul rates, against PostgreSQL through the HTTP API
 * (client answers, Oct 2026, Q14/Q5/Q4).
 *
 * The dispatcher records every load of an order with its carrier and rate;
 * the board shows them to the office; a load an invoice has paid keeps its
 * figures; a carrier is a trucking company; a quotation has no loads; a
 * driver is refused; every write is audited.
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

async function api(method: string, path: string, body?: unknown, token = tokens.AP_USER) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const today = () => new Date(`${businessDayOf()}T00:00:00.000Z`);

async function seedOrder(documentNumber: string, extra: Record<string, unknown> = {}) {
  const document = await prisma.orderDocument.create({
    data: { documentNumber, customerName: 'Example Customer', deliveryDate: today(), shippingAddress: '1 Example St, Cambridge', ...extra },
  });
  const line = await prisma.order.create({
    data: {
      spruceOrderId: `${documentNumber}-L1`, documentId: document.id, lineNumber: 1, customerName: 'Example Customer',
      product: 'Example Gravel', quantity: '12', unit: 'MT', spruceItemNumber: 'GRAVEL', lineClass: 'PRODUCT',
    },
  });
  return { document, line };
}

const supplier = (name: string, type: 'SUPPLIER' | 'TRUCKING_COMPANY', extra: Record<string, unknown> = {}) =>
  prisma.supplier.create({ data: { name, type, emailDomains: [], keywords: [], ...extra } });

describe('dispatch loads (PostgreSQL)', { skip: !runnable }, () => {
  before(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    for (const role of ['AP_USER', 'OWNER', 'ADMIN', 'DRIVER'] as const) {
      const user = await prisma.user.create({
        data: { name: `Example ${role}`, email: `${role.toLowerCase()}-loads@example.invalid`, passwordHash: 'x', role },
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
      'TRUNCATE TABLE "OrderDocument", "Order", "Delivery", "DeliveryHistory", "Driver", "Supplier", "DispatchLoad", "AuditLog", "Invoice", "InvoiceLineItem" RESTART IDENTITY CASCADE'
    );
  });

  after(async () => {
    server?.close();
    await prisma.$disconnect();
  });

  it('records loads with a rate, numbers them, defaults the pit, and audits each', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const pit = await supplier('Example Pit', 'SUPPLIER');
    const { document } = await seedOrder('9900-100001', { pickupSupplierId: pit.id });

    const first = await api('POST', `/api/dispatch/orders/${document.id}/loads`, {
      carrierSupplierId: haulage.id, rate: '95.50', rateUnit: 'LOAD', quantity: '1', ticketNumber: ' 4471 ',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.sequence, 1);
    assert.equal(first.body.rate, 95.5);
    assert.equal(first.body.rateUnit, 'LOAD');
    assert.equal(first.body.carrierName, 'Example Haulage');
    assert.equal(first.body.sourceSupplierId, pit.id, 'the order\'s pit is the default');
    assert.equal(first.body.ticketNumber, '4471');
    assert.equal(first.body.claimed, false);

    // CGC's own truck: no carrier, and a pit of its own.
    const other = await supplier('Second Pit', 'SUPPLIER');
    const second = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { sourceSupplierId: other.id }, tokens.OWNER);
    assert.equal(second.status, 201);
    assert.equal(second.body.sequence, 2);
    assert.equal(second.body.carrierSupplierId, null);
    assert.equal(second.body.sourceSupplierId, other.id);

    const list = await api('GET', `/api/dispatch/orders/${document.id}/loads`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.loads.map((load: { sequence: number }) => load.sequence), [1, 2]);
    assert.equal(list.body.pickupSupplierId, pit.id);

    const audit = await prisma.auditLog.findMany({ where: { entityId: document.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(audit.map(row => row.actionType), ['LOAD_CREATED', 'LOAD_CREATED']);
    assert.equal(audit[0]!.entityType, 'ORDER');
    assert.equal(audit[0]!.performedById, officeUserId);
    const details = audit[0]!.details as { loadId: string; changes: Array<{ field: string; to: string }> };
    assert.equal(details.loadId, first.body.id);
    assert.ok(details.changes.some(change => change.field === 'rate' && change.to === '95.50'));
  });

  it('changes a rate as LOAD_RATE_SET and anything else as LOAD_UPDATED, and removes a load', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const { document } = await seedOrder('9900-100002');
    const created = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { carrierSupplierId: haulage.id });
    assert.equal(created.status, 201);

    const priced = await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { rate: '42', rateUnit: 'HOUR', quantity: '3' });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    assert.equal(priced.body.rate, 42);
    assert.equal(priced.body.quantity, 3);

    const noted = await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { notes: 'Back gate' });
    assert.equal(noted.status, 200);
    // Sending the same values again writes nothing.
    assert.equal((await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { rate: '42.0000' })).status, 200);

    // A rate with no unit says nothing about what is billed.
    const unitless = await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { rateUnit: '' });
    assert.equal(unitless.status, 400);
    assert.match(unitless.body.error, /per load, per hour or per tonne/);
    const negative = await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { rate: '-3' });
    assert.equal(negative.status, 400);

    const removed = await api('DELETE', `/api/dispatch/loads/${created.body.id}`);
    assert.equal(removed.status, 200);
    assert.equal(await prisma.dispatchLoad.count(), 0);
    assert.equal((await api('DELETE', `/api/dispatch/loads/${created.body.id}`)).status, 404);

    const actions = (await prisma.auditLog.findMany({ where: { entityId: document.id }, orderBy: { createdAt: 'asc' } }))
      .map(row => row.actionType);
    assert.deepEqual(actions, ['LOAD_CREATED', 'LOAD_RATE_SET', 'LOAD_UPDATED', 'LOAD_DELETED']);
  });

  it('locks a load an invoice line has paid: only its note changes, and it cannot be removed', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const { document } = await seedOrder('9900-100003');
    const created = await api('POST', `/api/dispatch/orders/${document.id}/loads`, {
      carrierSupplierId: haulage.id, rate: '95', rateUnit: 'LOAD',
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'INV-EX-1', senderType: 'TRUCKING_COMPANY', supplierId: haulage.id, invoiceDate: today(),
        totalAmount: 95, currency: 'CAD', fileUrl: 'test://invoice', emailFrom: 'billing@haulage.example',
        emailSubject: 'Invoice', gmailMessageId: 'loads-test-1',
      },
    });
    const line = await prisma.invoiceLineItem.create({
      data: { invoiceId: invoice.id, lineNumber: 1, description: 'Haul', quantity: 1, unit: 'LOAD', unitRate: 95, lineTotal: 95, flag: 'OK' },
    });
    await prisma.dispatchLoad.update({ where: { id: created.body.id }, data: { claimedByLineItemId: line.id, claimedAt: new Date() } });

    const repriced = await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { rate: '90' });
    assert.equal(repriced.status, 409);
    assert.match(repriced.body.error, /already paid/);
    assert.equal((await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { carrierSupplierId: null })).status, 409);
    assert.equal((await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { tripRef: 'T-1' })).status, 409);
    const removed = await api('DELETE', `/api/dispatch/loads/${created.body.id}`);
    assert.equal(removed.status, 409);

    const noted = await api('PATCH', `/api/dispatch/loads/${created.body.id}`, { notes: 'Paid on INV-EX-1' });
    assert.equal(noted.status, 200);
    assert.equal(noted.body.claimed, true);
    const stored = await prisma.dispatchLoad.findUniqueOrThrow({ where: { id: created.body.id } });
    assert.equal(Number(stored.rate), 95);

    // The paid line going away frees the load rather than deleting it.
    await prisma.invoiceLineItem.delete({ where: { id: line.id } });
    assert.equal((await prisma.dispatchLoad.findUniqueOrThrow({ where: { id: created.body.id } })).claimedByLineItemId, null);
  });

  it('takes only an active trucking company as carrier', async () => {
    const quarry = await supplier('Example Quarry', 'SUPPLIER');
    const retired = await supplier('Old Haulage', 'TRUCKING_COMPANY', { active: false });
    const { document } = await seedOrder('9900-100004');

    const notTrucking = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { carrierSupplierId: quarry.id });
    assert.equal(notTrucking.status, 400);
    assert.match(notTrucking.body.error, /not a trucking company/);
    assert.equal((await api('POST', `/api/dispatch/orders/${document.id}/loads`, { carrierSupplierId: retired.id })).status, 400);
    assert.equal((await api('POST', `/api/dispatch/orders/${document.id}/loads`, { carrierSupplierId: 'Example' })).status, 400);
    assert.equal(await prisma.dispatchLoad.count(), 0);
    assert.equal(await prisma.auditLog.count(), 0);

    // The carrier picker lists trucking companies only.
    const options = await api('GET', '/api/suppliers/options?type=TRUCKING_COMPANY');
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.map((option: { name: string }) => option.name), []);
    await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const again = await api('GET', '/api/suppliers/options?type=TRUCKING_COMPANY');
    assert.deepEqual(again.body.map((option: { name: string; type: string }) => [option.name, option.type]), [['Example Haulage', 'TRUCKING_COMPANY']]);
    assert.equal((await api('GET', '/api/suppliers/options?type=PIT')).status, 400);
    assert.equal((await api('GET', '/api/suppliers/options')).body.length, 2, 'all active suppliers without a type');
  });

  it('refuses loads on a quotation, but lets a stray one be removed', async () => {
    const { document } = await seedOrder('9900-100005', { flags: ['QUOTE'] });
    const refused = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { notes: 'x' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /quotation/);

    const stray = await prisma.dispatchLoad.create({ data: { documentId: document.id, sequence: 1, setById: officeUserId } });
    assert.equal((await api('PATCH', `/api/dispatch/loads/${stray.id}`, { notes: 'x' })).status, 409);
    assert.equal((await api('DELETE', `/api/dispatch/loads/${stray.id}`)).status, 200);
    assert.equal((await api('POST', `/api/dispatch/orders/00000000-0000-4000-8000-000000000000/loads`, {})).status, 404);
    assert.equal((await api('GET', '/api/dispatch/orders/not-an-id/loads')).status, 404);
  });

  it('refuses a driver on every load route', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const { document } = await seedOrder('9900-100006');
    const load = await prisma.dispatchLoad.create({
      data: { documentId: document.id, sequence: 1, carrierSupplierId: haulage.id, rate: 95, rateUnit: 'LOAD', tripRef: 'T-1', setById: officeUserId },
    });
    for (const [method, path, body] of [
      ['GET', `/api/dispatch/orders/${document.id}/loads`, undefined],
      ['POST', `/api/dispatch/orders/${document.id}/loads`, { rate: '1', rateUnit: 'LOAD' }],
      ['PATCH', `/api/dispatch/loads/${load.id}`, { rate: '1' }],
      ['DELETE', `/api/dispatch/loads/${load.id}`, undefined],
      ['POST', `/api/dispatch/loads/${load.id}/copy-rate-to-trip`, undefined],
    ] as const) {
      const response = await api(method, path, body, tokens.DRIVER);
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(JSON.stringify(response.body).includes('95'), false);
    }
    const stored = await prisma.dispatchLoad.findUniqueOrThrow({ where: { id: load.id } });
    assert.equal(Number(stored.rate), 95);
    assert.equal(await prisma.auditLog.count(), 0);
  });

  it('keeps one carrier per brokered trip and copies the trip\'s rate to its other loads', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const otherHaulage = await supplier('Other Haulage', 'TRUCKING_COMPANY');
    const a = await seedOrder('9900-100007');
    const b = await seedOrder('9900-100008');
    const c = await seedOrder('9900-100009');

    const first = await api('POST', `/api/dispatch/orders/${a.document.id}/loads`, {
      carrierSupplierId: haulage.id, tripRef: 't-21', rate: '180', rateUnit: 'LOAD',
    });
    assert.equal(first.body.tripRef, 'T-21');
    const second = await api('POST', `/api/dispatch/orders/${b.document.id}/loads`, { carrierSupplierId: haulage.id, tripRef: 'T-21' });
    assert.equal(second.status, 201);
    assert.deepEqual(second.body.trip, { loads: 2, orders: ['9900-100007', '9900-100008'], sameRate: false });

    const mismatch = await api('POST', `/api/dispatch/orders/${c.document.id}/loads`, { carrierSupplierId: otherHaulage.id, tripRef: 'T-21' });
    assert.equal(mismatch.status, 409);
    assert.match(mismatch.body.error, /Trip T-21 is with Example Haulage/);
    const fleet = await api('POST', `/api/dispatch/orders/${c.document.id}/loads`, { tripRef: 'T-21' });
    assert.equal(fleet.status, 409, 'CGC fleet is a carrier of its own');

    const copied = await api('POST', `/api/dispatch/loads/${first.body.id}/copy-rate-to-trip`);
    assert.equal(copied.status, 200, JSON.stringify(copied.body));
    assert.deepEqual(copied.body, { tripRef: 'T-21', updated: 1, skipped: 0 });
    const secondNow = await prisma.dispatchLoad.findUniqueOrThrow({ where: { id: second.body.id } });
    assert.equal(Number(secondNow.rate), 180);
    assert.equal(secondNow.rateUnit, 'LOAD');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: b.document.id, actionType: 'LOAD_RATE_SET' } });
    assert.equal((audit.details as { copiedFromLoadId: string }).copiedFromLoadId, first.body.id);

    // Copying again changes nothing; a load with no trip has nothing to copy to.
    assert.deepEqual((await api('POST', `/api/dispatch/loads/${first.body.id}/copy-rate-to-trip`)).body, { tripRef: 'T-21', updated: 0, skipped: 0 });
    const loose = await api('POST', `/api/dispatch/orders/${c.document.id}/loads`, { carrierSupplierId: haulage.id, rate: '1', rateUnit: 'LOAD' });
    assert.equal((await api('POST', `/api/dispatch/loads/${loose.body.id}/copy-rate-to-trip`)).status, 400);
  });

  it('shows loads on the office board, files them under the stop, and defaults a brokered driver', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const pool = await seedOrder('9900-100010');
    await api('POST', `/api/dispatch/orders/${pool.document.id}/loads`, { carrierSupplierId: haulage.id, rate: '95', rateUnit: 'LOAD' });

    const boardBefore = (await api('GET', `/api/dispatch?date=${businessDayOf()}`)).body;
    const row = boardBefore.unassignedOrders.find((order: { id: string }) => order.id === pool.document.id);
    assert.equal(row.haulLoads.length, 1);
    assert.equal(row.haulLoads[0].rate, 95);
    assert.equal(row.haulLoads[0].carrierName, 'Example Haulage');

    // Assigned to a brokered driver: the load waiting in the pool joins the stop.
    const broker = await prisma.driver.create({
      data: { name: 'Example Broker', phone: '519-555-0711', type: 'INDEPENDENT', companyName: 'Example Haulage' },
    });
    assert.equal((await api('POST', '/api/dispatch/assign', { documentId: pool.document.id, driverId: broker.id })).status, 200);
    const stop = await prisma.delivery.findUniqueOrThrow({ where: { documentId: pool.document.id } });
    assert.equal((await prisma.dispatchLoad.findFirstOrThrow({ where: { documentId: pool.document.id } })).deliveryId, stop.id);

    // A new load on that stop takes the stop and its brokered driver.
    const next = await api('POST', `/api/dispatch/orders/${pool.document.id}/loads`, {});
    assert.equal(next.body.deliveryId, stop.id);
    assert.equal(next.body.driverId, broker.id);
    assert.equal(next.body.driverType, 'INDEPENDENT');

    const boardAfter = (await api('GET', `/api/dispatch?date=${businessDayOf()}`)).body;
    const run = boardAfter.drivers.find((driver: { id: string }) => driver.id === broker.id);
    assert.equal(run.deliveries[0].order.haulLoads.length, 2);
  });

  it('moves the loads\' brokered driver with the stop, but not a paid load or a driver named on purpose', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const { document } = await seedOrder('9900-100011');
    const brokerA = await prisma.driver.create({ data: { name: 'Example Broker A', phone: '519-555-0721', type: 'INDEPENDENT' } });
    const brokerB = await prisma.driver.create({ data: { name: 'Example Broker B', phone: '519-555-0722', type: 'INDEPENDENT' } });
    const brokerC = await prisma.driver.create({ data: { name: 'Example Broker C', phone: '519-555-0723', type: 'INDEPENDENT' } });
    const fleet = await prisma.driver.create({ data: { name: 'Example Fleet Driver', phone: '519-555-0724', type: 'CGC_FLEET' } });

    // A load waiting in the pool takes the brokered driver it is given to.
    const pooled = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { carrierSupplierId: haulage.id });
    assert.equal(pooled.body.driverId, null);
    assert.equal((await api('POST', '/api/dispatch/assign', { documentId: document.id, driverId: brokerA.id })).status, 200);
    const driverOf = async (id: string) => (await prisma.dispatchLoad.findUniqueOrThrow({ where: { id } })).driverId;
    assert.equal(await driverOf(pooled.body.id), brokerA.id);

    const onPurpose = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { driverId: brokerC.id });
    const paid = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { carrierSupplierId: haulage.id, rate: '90', rateUnit: 'LOAD' });
    assert.equal(paid.body.driverId, brokerA.id);
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'INV-EX-2', senderType: 'TRUCKING_COMPANY', supplierId: haulage.id, invoiceDate: today(),
        totalAmount: 90, currency: 'CAD', fileUrl: 'test://invoice', emailFrom: 'billing@haulage.example',
        emailSubject: 'Invoice', gmailMessageId: 'loads-test-2',
      },
    });
    const line = await prisma.invoiceLineItem.create({
      data: { invoiceId: invoice.id, lineNumber: 1, description: 'Haul', quantity: 1, unit: 'LOAD', unitRate: 90, lineTotal: 90, flag: 'OK' },
    });
    await prisma.dispatchLoad.update({ where: { id: paid.body.id }, data: { claimedByLineItemId: line.id, claimedAt: new Date() } });

    // Moved to another brokered truck: the loads that went with A go with B.
    assert.equal((await api('POST', '/api/dispatch/assign', { documentId: document.id, driverId: brokerB.id })).status, 200);
    assert.equal(await driverOf(pooled.body.id), brokerB.id);
    assert.equal(await driverOf(onPurpose.body.id), brokerC.id);
    assert.equal(await driverOf(paid.body.id), brokerA.id, 'a paid load keeps its driver');

    // Moved to a CGC truck: no brokered driver is named any more.
    assert.equal((await api('POST', '/api/dispatch/assign', { documentId: document.id, driverId: fleet.id })).status, 200);
    assert.equal(await driverOf(pooled.body.id), null);
    assert.equal(await driverOf(onPurpose.body.id), brokerC.id);

    // Back to a broker, then off any truck.
    assert.equal((await api('POST', '/api/dispatch/assign', { documentId: document.id, driverId: brokerB.id })).status, 200);
    assert.equal(await driverOf(pooled.body.id), brokerB.id);
    assert.equal((await api('POST', '/api/dispatch/unassign', { documentId: document.id })).status, 200);
    assert.equal(await driverOf(pooled.body.id), null);
    assert.equal(await driverOf(onPurpose.body.id), brokerC.id);
  });
  it('re-checks a waiting trucking invoice when dispatch fills in, copies or removes a load\'s rate', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const first = await seedOrder('9900-100031');
    const second = await seedOrder('9900-100032');
    const unpriced = await api('POST', `/api/dispatch/orders/${first.document.id}/loads`, {
      carrierSupplierId: haulage.id, ticketNumber: 'TK-3101', tripRef: 'T-31',
    });
    const partner = await api('POST', `/api/dispatch/orders/${second.document.id}/loads`, {
      carrierSupplierId: haulage.id, tripRef: 'T-31',
    });
    assert.equal(unpriced.status, 201);
    assert.equal(partner.status, 201);

    // The carrier's invoice arrived before dispatch set a rate on the trip.
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'INV-EX-31', senderType: 'TRUCKING_COMPANY', supplierId: haulage.id, invoiceDate: today(),
        totalAmount: 120, currency: 'CAD', fileUrl: 'test://invoice', emailFrom: 'billing@haulage.example',
        emailSubject: 'Invoice', gmailMessageId: 'loads-test-31',
        lineItems: {
          create: {
            lineNumber: 1, description: 'Tri-axle haul', ticketNumber: 'TK-3101', serviceDate: today(),
            quantity: 1, unit: 'load', unitRate: 120, lineTotal: 120, flag: 'OK',
          },
        },
      },
      include: { lineItems: true },
    });
    const lineId = invoice.lineItems[0]!.id;
    const { matchInvoiceById } = await import('../src/modules/matching/matching.service.js');
    await matchInvoiceById(invoice.id);
    const verdict = async () => {
      const row = await prisma.matchResult.findUniqueOrThrow({ where: { invoiceLineId: lineId } });
      const checks = row.evidence as Array<{ name: string; passed: boolean; code?: string }>;
      return { status: row.status, rate: checks.find(check => check.name === 'haulRate'), loadIds: row.loadIds };
    };
    assert.equal((await verdict()).rate?.code, 'NO_RATE_SET');

    // Dispatch sets the rate on one load: the trip's loads disagree now.
    const priced = await api('PATCH', `/api/dispatch/loads/${unpriced.body.id}`, { rate: '120', rateUnit: 'LOAD' });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    assert.equal((await verdict()).rate?.code, 'TRIP_RATES_DIFFER', 'decided again without anyone re-running it');

    // Copied to the trip's other load: one rate, and the line passes.
    const copied = await api('POST', `/api/dispatch/loads/${unpriced.body.id}/copy-rate-to-trip`);
    assert.equal(copied.status, 200);
    const passed = await verdict();
    assert.equal(passed.status, 'MATCHED');
    assert.equal(passed.rate?.passed, true);
    const line = await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: lineId } });
    assert.equal(Number(line.approvedTotal), 120);

    // Removing the loads leaves the line with nothing to bill against.
    assert.equal((await api('DELETE', `/api/dispatch/loads/${partner.body.id}`)).status, 200);
    assert.equal((await api('DELETE', `/api/dispatch/loads/${unpriced.body.id}`)).status, 200);
    const gone = await verdict();
    assert.equal(gone.status, 'UNMATCHED');
    assert.deepEqual(gone.loadIds, []);
  });

  it('a note on a load re-checks nothing, and a failed re-check never fails the change', async () => {
    const haulage = await supplier('Example Haulage', 'TRUCKING_COMPANY');
    const { document } = await seedOrder('9900-100033');
    const load = await api('POST', `/api/dispatch/orders/${document.id}/loads`, { carrierSupplierId: haulage.id });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'INV-EX-33', senderType: 'TRUCKING_COMPANY', supplierId: haulage.id, invoiceDate: today(),
        totalAmount: 120, currency: 'CAD', fileUrl: 'test://invoice', emailFrom: 'billing@haulage.example',
        emailSubject: 'Invoice', gmailMessageId: 'loads-test-33',
        lineItems: { create: { lineNumber: 1, description: 'Haul', quantity: 1, unit: 'load', unitRate: 120, lineTotal: 120, flag: 'OK' } },
      },
    });
    // Never matched: a re-check would give it a verdict.
    assert.equal((await api('PATCH', `/api/dispatch/loads/${load.body.id}`, { notes: 'Gate code 4471' })).status, 200);
    assert.equal(await prisma.matchResult.count({ where: { invoiceLine: { invoiceId: invoice.id } } }), 0);

    // The re-check reads the invoice lines; make that read fail.
    const { prisma: client } = await import('../src/db/prisma.js');
    const original = client.invoiceLineItem.findMany;
    (client.invoiceLineItem as { findMany: unknown }).findMany = async () => {
      throw new Error('database unavailable');
    };
    const quiet = mock.method(console, 'error', () => {});
    try {
      const changed = await api('PATCH', `/api/dispatch/loads/${load.body.id}`, { rate: '95', rateUnit: 'LOAD' });
      assert.equal(changed.status, 200, 'the rate is saved whatever the re-check does');
      assert.equal(changed.body.rate, 95);
    } finally {
      (client.invoiceLineItem as { findMany: unknown }).findMany = original;
      quiet.mock.restore();
    }
    assert.ok(quiet.mock.calls.some(call => String(call.arguments[0]).includes('haul line recompute failed')));
  });
});
