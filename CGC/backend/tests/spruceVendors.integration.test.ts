// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';

import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { normaliseVendorCode } from '../src/modules/supplier/spruceVendors.service.js';

/**
 * Mapping Spruce vendor codes from the Supplier page, against PostgreSQL.
 *
 * The import names a line's vendor only by code; a code with no mapping leaves
 * the line with no supplier. These check that the office can see those codes,
 * map one (which links the lines already imported), refuse to move a code that
 * belongs to another supplier, and retire one without deleting it. Drivers get
 * none of it. Codes, names and POs are invented.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();

describe('Spruce vendor codes (PostgreSQL)', { skip: !(confirmed && loopback) }, () => {
  let server: Server;
  let baseUrl: string;
  let officeToken: string;
  let driverToken: string;
  let supplierId: string;
  let otherSupplierId: string;

  async function api(method: string, path: string, body?: unknown, token = officeToken) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  before(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditLog", "MatchResult", "SupplierSpruceVendor", "Order", "Supplier", "User" RESTART IDENTITY CASCADE'
    );
    supplierId = (await prisma.supplier.create({ data: { name: 'Example Pavers', type: 'SUPPLIER', emailDomains: [] } })).id;
    otherSupplierId = (await prisma.supplier.create({ data: { name: 'Other Example Yard', type: 'SUPPLIER', emailDomains: [] } })).id;
    await prisma.supplierSpruceVendor.create({ data: { code: 'OTHERV01', supplierId: otherSupplierId } });

    // Two lines imported before EXAMPLEV01 was mapped, one already linked by a
    // person to another supplier (left alone), and one under a mapped code.
    const line = (n: number, vendorCode: string, extra: Record<string, unknown> = {}) =>
      prisma.order.create({
        data: {
          spruceOrderId: `9900-0001-L${n}`, customerName: 'A Customer', product: 'Synthetic Paver 60mm',
          quantity: 10, unit: 'SQFT', orderDate: new Date('2026-10-28'), poNumber: `9900-10000${n}`,
          vendorCode, vendorLocation: 'Example Yard', ...extra,
        },
      });
    await line(1, 'EXAMPLEV01');
    await line(2, 'examplev01');
    await line(3, 'EXAMPLEV01', { supplierId: otherSupplierId });
    await line(4, 'OTHERV01');

    const office = await prisma.user.create({ data: { name: 'Desk', email: 'desk-vendors@example.invalid', passwordHash: 'x', role: 'AP_USER' } });
    const driver = await prisma.user.create({ data: { name: 'Driver', email: 'driver-vendors@example.invalid', passwordHash: 'x', role: 'DRIVER' } });
    officeToken = jwt.sign({ id: office.id, email: office.email, role: office.role }, env.jwtSecret);
    driverToken = jwt.sign({ id: driver.id, email: driver.email, role: driver.role }, env.jwtSecret);

    const { default: app } = await import('../src/app.js');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // Let the background re-match of the linked POs finish before disconnecting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    server?.close();
    await prisma.$disconnect();
  });

  it('reads codes the way Spruce prints them', () => {
    assert.equal(normaliseVendorCode(' examplev01 '), 'EXAMPLEV01');
    assert.equal(normaliseVendorCode('ABC.D-1_2'), 'ABC.D-1_2');
    assert.equal(normaliseVendorCode('has space'), null);
    assert.equal(normaliseVendorCode(''), null);
    assert.equal(normaliseVendorCode(42), null);
  });

  it('lists the codes imported lines carry that map to no supplier', async () => {
    const unmapped = await api('GET', '/api/spruce-vendors/unmapped');
    assert.equal(unmapped.status, 200);
    assert.deepEqual(unmapped.body.map((c: { code: string; lineCount: number }) => [c.code, c.lineCount]), [['EXAMPLEV01', 2]]);
    assert.equal(unmapped.body[0].location, 'Example Yard');
  });

  it('maps a code, links the lines already imported, and audits it', async () => {
    const added = await api('POST', '/api/spruce-vendors', { supplierId, code: 'examplev01' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.code, 'EXAMPLEV01');
    assert.equal(added.body.linkedLines, 2);

    const lines = await prisma.order.findMany({ where: { vendorCode: { equals: 'EXAMPLEV01', mode: 'insensitive' } }, orderBy: { spruceOrderId: 'asc' } });
    assert.deepEqual(lines.map((l) => l.supplierId), [supplierId, supplierId, otherSupplierId], 'a line a person linked keeps its supplier');

    const listed = await api('GET', `/api/spruce-vendors?supplierId=${supplierId}`);
    assert.deepEqual(listed.body.map((c: { code: string; active: boolean }) => [c.code, c.active]), [['EXAMPLEV01', true]]);
    assert.deepEqual((await api('GET', '/api/spruce-vendors/unmapped')).body, []);

    const audit = await prisma.auditLog.findMany({ where: { entityType: 'SUPPLIER', entityId: supplierId } });
    assert.deepEqual(audit.map((a) => a.actionType), ['SPRUCE_VENDOR_MAPPED']);

    const again = await api('POST', '/api/spruce-vendors', { supplierId, code: 'EXAMPLEV01' });
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false);
  });

  it("refuses to move a code that belongs to another supplier, and a malformed code", async () => {
    const taken = await api('POST', '/api/spruce-vendors', { supplierId, code: 'OTHERV01' });
    assert.equal(taken.status, 409);
    assert.match(taken.body.error, /already belongs to Other Example Yard/);
    const mapping = await prisma.supplierSpruceVendor.findUniqueOrThrow({ where: { code: 'OTHERV01' } });
    assert.equal(mapping.supplierId, otherSupplierId);

    assert.equal((await api('POST', '/api/spruce-vendors', { supplierId, code: 'not a code' })).status, 400);
    assert.equal((await api('POST', '/api/spruce-vendors', { code: 'EXAMPLEV02' })).status, 400);
  });

  it("retires a code instead of deleting it, and only under its own supplier", async () => {
    assert.equal((await api('DELETE', `/api/spruce-vendors/OTHERV01?supplierId=${supplierId}`)).status, 404);

    const retired = await api('DELETE', `/api/spruce-vendors/EXAMPLEV01?supplierId=${supplierId}`);
    assert.equal(retired.status, 200);
    assert.equal(retired.body.active, false);
    const row = await prisma.supplierSpruceVendor.findUniqueOrThrow({ where: { code: 'EXAMPLEV01' } });
    assert.equal(row.active, false);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: supplierId }, orderBy: { createdAt: 'asc' } })).map((a) => a.actionType);
    assert.deepEqual(actions, ['SPRUCE_VENDOR_MAPPED', 'SPRUCE_VENDOR_RETIRED']);

    // A retired code can be mapped again on purpose.
    const remapped = await api('POST', '/api/spruce-vendors', { supplierId: otherSupplierId, code: 'EXAMPLEV01' });
    assert.equal(remapped.status, 201);
    assert.equal((await prisma.supplierSpruceVendor.findUniqueOrThrow({ where: { code: 'EXAMPLEV01' } })).supplierId, otherSupplierId);
  });

  it('gives a driver 403 on every route', async () => {
    const statuses = [
      (await api('GET', '/api/spruce-vendors/unmapped', undefined, driverToken)).status,
      (await api('GET', `/api/spruce-vendors?supplierId=${supplierId}`, undefined, driverToken)).status,
      (await api('POST', '/api/spruce-vendors', { supplierId, code: 'DRIVERV01' }, driverToken)).status,
      (await api('DELETE', `/api/spruce-vendors/OTHERV01?supplierId=${otherSupplierId}`, undefined, driverToken)).status,
    ];
    assert.deepEqual(statuses, [403, 403, 403, 403]);
    assert.equal(await prisma.supplierSpruceVendor.count({ where: { code: 'DRIVERV01' } }), 0);
  });
});
