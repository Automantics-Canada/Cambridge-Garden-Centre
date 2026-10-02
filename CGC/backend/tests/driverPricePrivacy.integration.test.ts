// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { DeliveriesService } from '../src/modules/deliveries/deliveries.service.js';
import { DriverService } from '../src/modules/drivers/driver.service.js';

/**
 * Drivers must never see what an order is sold or bought for.
 *
 * Order lines carry unit price and unit cost since the Spruce import, and the
 * order record carries totals and margin. Every path a driver can read is
 * driven here against a priced order, and none may let a figure through.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

/** Every key that would put money in front of a driver. */
const MONEY_KEYS = ['unitPrice', 'unitCost', 'poValue', 'totalWithTax', 'remaining', 'remainingDeposit', 'grossMarginPct', 'supplier'];

function moneyKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => moneyKeysIn(item, `${path}[${index}]`));
  if (value === null || typeof value !== 'object' || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(MONEY_KEYS.includes(key) ? [`${path}.${key}`] : []),
    ...moneyKeysIn(child, `${path}.${key}`),
  ]);
}

describe('driver responses carry no prices (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let userId: string;
  let driverId: string;
  let deliveryId: string;

  before(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "OrderDocument", "Order", "Driver", "User", "Delivery" RESTART IDENTITY CASCADE'
    );
    const user = await prisma.user.create({
      data: { name: 'Driver', email: 'driver-privacy@example.test', passwordHash: 'x', role: 'DRIVER' },
    });
    userId = user.id;
    const driver = await prisma.driver.create({ data: { name: 'Driver', phone: '519-555-0199', userId } });
    driverId = driver.id;
    const document = await prisma.orderDocument.create({
      data: {
        documentNumber: '9900-000777',
        customerName: 'Synthetic Customer',
        deliveryDate: new Date('2026-09-02'),
        shippingAddress: '1 Example St, Cambridge',
        totalWithTax: '575.08',
        grossMarginPct: '45.80',
      },
    });
    const line = await prisma.order.create({
      data: {
        spruceOrderId: '9900-000777-L1',
        documentId: document.id,
        lineNumber: 1,
        customerName: 'Synthetic Customer',
        product: 'Clear Stone',
        quantity: '12',
        unit: 'MT',
        unitPrice: '35.91',
        unitCost: '16.50',
        poValue: '942.55',
        orderDate: new Date('2026-09-01'),
      },
    });
    const delivery = await prisma.delivery.create({
      data: { orderId: line.id, driverId, status: 'PLACED', priority: 1 },
    });
    deliveryId = delivery.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('keeps prices out of the driver\'s own profile and run', async () => {
    const profile = await DriverService.getDriverByUserId(userId);
    assert.equal(profile?.stats.totalToday, 1, 'the seeded stop is counted');
    assert.deepEqual(moneyKeysIn(profile), []);

    assert.deepEqual(moneyKeysIn(await DriverService.getDriverDeliveries(driverId)), []);
  });

  it('keeps prices out of the delivery list a driver reads', async () => {
    const list = await DeliveriesService.getDeliveries({ driverId }, 1, 50, 'priority', 'driver');
    assert.equal(list.data.length, 1);
    assert.deepEqual(moneyKeysIn(list), []);

    // What the phone is actually given: the current stop.
    const current = await DeliveriesService.getCurrentStop(driverId);
    assert.equal(current.data.length, 1);
    assert.deepEqual(moneyKeysIn(current), []);
  });

  it('keeps prices out of the answer to a driver\'s status update', async () => {
    const updated = await DeliveriesService.updateStatus(deliveryId, 'IN_TRANSIT', undefined, 'PLACED');
    assert.equal(updated.status, 'IN_TRANSIT');
    assert.deepEqual(moneyKeysIn(updated), []);
  });
});
