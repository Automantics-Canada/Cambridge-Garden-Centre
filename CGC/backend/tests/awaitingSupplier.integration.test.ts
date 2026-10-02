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
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { getOrderForEditing } from '../src/modules/orders/edits/orderEdits.service.js';

/**
 * "Awaiting supplier: <supplier> PO <number>" against PostgreSQL.
 *
 * The office sees who an order waits on and under which PO, on the board for
 * any day, the undated list and the editor. Drivers are given the same orders
 * through the same document select, and must see none of it: who supplies an
 * order is office business, like what it costs.
 *
 * Every number, code and name here is invented.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

const TODAY = '2026-09-01';
const LATER = '2026-09-04';
const SUPPLIER = 'Example Pavers';
const VENDOR = 'EXAMPLEV01';
const PO = '9900-100001';
const UNMAPPED_VENDOR = 'UNMAPPED01';
const SECOND_PO = '9900-100002';

/** Keys that would tell a driver who supplies an order, or what it is worth. */
const OFFICE_ONLY_KEYS = [
  'unitPrice', 'unitCost', 'poValue', 'totalWithTax', 'remaining', 'remainingDeposit', 'grossMarginPct',
  'supplier', 'supplierId', 'supplierName', 'awaitingSupplier', 'poNumber', 'vendorCode', 'vendorLocation',
];

function officeKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => officeKeysIn(item, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(OFFICE_ONLY_KEYS.includes(key) ? [`${path}.${key}`] : []),
    ...officeKeysIn(child, `${path}.${key}`),
  ]);
}

/** Nor may the values leak under some other name. */
function officeValuesIn(body: unknown): string[] {
  const text = JSON.stringify(body);
  return [SUPPLIER, VENDOR, PO, UNMAPPED_VENDOR, SECOND_PO].filter(value => text.includes(value));
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('awaiting supplier, for the office only (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let server: Server;
  let baseUrl: string;
  let adminToken: string;
  let driverToken: string;
  let driverId: string;
  let pooledId: string;
  let onRunId: string;
  let undatedId: string;
  let plainId: string;

  /** An order whose lines were bought in under `pos`; `supplierId` on the line only where given. */
  async function seedOrder(
    documentNumber: string,
    deliveryDate: string | null,
    pos: Array<{ poNumber: string; vendorCode: string | null; supplierId?: string }>,
  ) {
    const document = await prisma.orderDocument.create({
      data: {
        documentNumber,
        customerName: `Customer ${documentNumber}`,
        deliveryDate: deliveryDate ? day(deliveryDate) : null,
        shippingAddress: '1 Example St, Cambridge',
        addressNormalized: '1 Example St, Cambridge',
        deliveryInstructions: 'CUSTOMER ON SITE TO DIRECT DELIVERY',
        totalWithTax: '575.08',
        flags: pos.length > 0 ? ['AWAITING_SUPPLIER', 'CUSTOMER_ON_SITE'] : ['CUSTOMER_ON_SITE'],
      },
    });
    const lines = pos.length > 0 ? pos : [{ poNumber: null, vendorCode: null }];
    for (const [index, line] of lines.entries()) {
      await prisma.order.create({
        data: {
          spruceOrderId: `${documentNumber}-L${index + 1}`,
          documentId: document.id,
          lineNumber: index + 1,
          spruceItemNumber: `PAVER${index + 1}`,
          lineClass: 'PRODUCT',
          customerName: document.customerName,
          product: 'Synthetic Paver 60mm',
          quantity: '120',
          unit: 'SQFT',
          unitPrice: '5.10',
          unitCost: '3.20',
          poValue: '942.55',
          poNumber: line.poNumber,
          vendorCode: line.vendorCode,
          vendorLocation: line.vendorCode ? 'Example Yard' : null,
          supplierId: 'supplierId' in line ? line.supplierId : null,
          orderDate: day('2026-08-28'),
        },
      });
    }
    return document.id;
  }

  async function get(path: string, token: string) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, `${path} answered ${response.status}`);
    return response.json() as Promise<unknown>;
  }

  before(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SupplierSpruceVendor", "Supplier", "OrderDocument", "Order", "Driver", "User", "Delivery" ' +
        'RESTART IDENTITY CASCADE'
    );

    const supplier = await prisma.supplier.create({
      data: { name: SUPPLIER, type: 'SUPPLIER', emailDomains: [], keywords: [] },
    });
    await prisma.supplierSpruceVendor.create({ data: { code: VENDOR, supplierId: supplier.id } });

    // Imported before the vendor was mapped: the line has no supplier, the mapping names it.
    pooledId = await seedOrder('9900-000101', LATER, [
      { poNumber: PO, vendorCode: VENDOR },
      { poNumber: PO, vendorCode: VENDOR },
    ]);
    // Imported after: the line names its supplier itself. A second PO with an unmapped vendor.
    onRunId = await seedOrder('9900-000102', TODAY, [
      { poNumber: PO, vendorCode: VENDOR, supplierId: supplier.id },
      { poNumber: SECOND_PO, vendorCode: UNMAPPED_VENDOR },
    ]);
    undatedId = await seedOrder('9900-000103', null, [{ poNumber: PO, vendorCode: VENDOR }]);
    plainId = await seedOrder('9900-000104', LATER, []);

    const admin = await prisma.user.create({
      data: { name: 'Admin', email: 'admin-awaiting@example.test', passwordHash: 'x', role: 'ADMIN' },
    });
    const driverUser = await prisma.user.create({
      data: { name: 'Driver', email: 'driver-awaiting@example.test', passwordHash: 'x', role: 'DRIVER' },
    });
    driverId = (await prisma.driver.create({ data: { name: 'Driver', phone: '519-555-0177', userId: driverUser.id } })).id;
    await DispatchService.assignOrder(onRunId, driverId);

    adminToken = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, env.jwtSecret);
    driverToken = jwt.sign({ id: driverUser.id, email: driverUser.email, role: driverUser.role }, env.jwtSecret);

    const { default: app } = await import('../src/app.js');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await prisma.$disconnect();
  });

  it('names the supplier through the vendor mapping on a later day\'s board', async () => {
    const board = await DispatchService.getDispatchBoard(LATER, TODAY);
    const pooled = board.unassignedOrders.find(order => order.id === pooledId);
    const plain = board.unassignedOrders.find(order => order.id === plainId);

    assert.deepEqual(pooled?.awaitingSupplier, [{ supplierName: SUPPLIER, poNumber: PO }], 'one entry for a PO on two lines');
    assert.deepEqual(plain?.awaitingSupplier, []);

    // The supplier is named, never the supplier record nor any money.
    const keys = officeKeysIn(board).filter(path => !/\.awaitingSupplier(\[\d+\]\.(supplierName|poNumber))?$/.test(path));
    assert.deepEqual(keys, []);
  });

  it('names every PO on a driver\'s run, falling back to the vendor code', async () => {
    const board = await DispatchService.getDispatchBoard(TODAY, TODAY);
    const run = board.drivers.find(driver => driver.id === driverId);
    const order = run?.deliveries[0]?.order as { id: string; awaitingSupplier?: unknown } | undefined;

    assert.equal(order?.id, onRunId);
    assert.deepEqual(order?.awaitingSupplier, [
      { supplierName: SUPPLIER, poNumber: PO },
      { supplierName: UNMAPPED_VENDOR, poNumber: SECOND_PO },
    ]);
  });

  it('names it on the undated list and in the editor', async () => {
    const undated = await DispatchService.getUndatedOrders();
    assert.deepEqual(
      undated.find(order => order.id === undatedId)?.awaitingSupplier,
      [{ supplierName: SUPPLIER, poNumber: PO }]
    );

    const editing = await getOrderForEditing('9900-000102', TODAY);
    assert.deepEqual(editing.awaitingSupplier, [
      { supplierName: SUPPLIER, poNumber: PO },
      { supplierName: UNMAPPED_VENDOR, poNumber: SECOND_PO },
    ]);
    assert.deepEqual((await getOrderForEditing(plainId, TODAY)).awaitingSupplier, []);
  });

  it('is on the office board over HTTP', async () => {
    const board = await get(`/api/dispatch?date=${LATER}`, adminToken) as { unassignedOrders: Array<{ id: string; awaitingSupplier?: unknown }> };
    assert.deepEqual(
      board.unassignedOrders.find(order => order.id === pooledId)?.awaitingSupplier,
      [{ supplierName: SUPPLIER, poNumber: PO }]
    );
    const editor = await get(`/api/orders/documents/${onRunId}`, adminToken) as { awaitingSupplier?: unknown[] };
    assert.equal(editor.awaitingSupplier?.length, 2);
  });

  it('never reaches the driver: current stop, delivery list or profile', async () => {
    const stop = await get('/api/deliveries', driverToken) as Array<{ document?: { id: string; deliveryInstructions: string } }>;
    assert.equal(stop.length, 1, 'the driver is given their stop');
    assert.equal(stop[0]?.document?.id, onRunId, 'the stop is the order awaiting a supplier');
    assert.equal(stop[0]?.document?.deliveryInstructions, 'CUSTOMER ON SITE TO DIRECT DELIVERY');

    const responses = {
      currentStop: stop,
      envelope: await get('/api/deliveries?page=1&limit=10', driverToken),
      profile: await get('/api/drivers/me', driverToken),
    };
    for (const [name, body] of Object.entries(responses)) {
      assert.deepEqual(officeKeysIn(body), [], `${name} carries an office-only key`);
      assert.deepEqual(officeValuesIn(body), [], `${name} names the supplier, vendor or PO`);
    }
  });

  it('never reaches the driver in the answer to a status update', async () => {
    const stop = await prisma.delivery.findUniqueOrThrow({ where: { documentId: onRunId } });
    const response = await fetch(`${baseUrl}/api/deliveries/${stop.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${driverToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'IN_TRANSIT' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(officeKeysIn(body), []);
    assert.deepEqual(officeValuesIn(body), []);
  });
});
