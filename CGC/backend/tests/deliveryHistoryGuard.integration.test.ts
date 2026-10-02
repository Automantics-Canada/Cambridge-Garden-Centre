// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { updateStatus, uploadPhoto } from '../src/modules/deliveries/deliveries.controller.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import type { UserRole } from '../src/middleware/authMiddleware.js';

/**
 * Spec §8: an earlier day is "read-only except status corrections by an admin".
 *
 * The routes' own handlers against PostgreSQL. A finished stop (DELIVERED or
 * CANCELLED) is history: an AP user is refused it with 403, while an admin or
 * owner goes on to the state machine — which allows no move out of a finished
 * state at all, so they get its 409. An unfinished stop from an earlier day is
 * Carried over work and stays open to the office and to its driver.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';
const PAST_DAY = new Date('2026-08-14T00:00:00.000Z');

type SessionUser = { id: string; email: string; role: UserRole };

/** Just enough of Express's response for the handlers. */
function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

async function patchStatus(user: SessionUser, id: string, status: string) {
  const res = fakeResponse();
  await updateStatus({ params: { id }, body: { status }, query: {}, user } as any, res as any);
  return res;
}

/** A photo request with no file: it reaches the file check only if let past the guards. */
async function postPhoto(user: SessionUser, id: string) {
  const res = fakeResponse();
  await uploadPhoto({ params: { id }, body: { type: 'delivery' }, query: {}, user } as any, res as any);
  return res;
}

async function seedUser(role: UserRole): Promise<SessionUser> {
  const email = `${role.toLowerCase()}-guard@example.test`;
  const user = await prisma.user.create({ data: { name: role, email, passwordHash: 'x', role } });
  return { id: user.id, email, role };
}

/** A synthetic order due on an earlier day, given to `driverId`. */
async function seedStop(documentNumber: string, driverId: string) {
  const document = await prisma.orderDocument.create({
    data: {
      documentNumber,
      customerName: `Customer ${documentNumber}`,
      deliveryDate: PAST_DAY,
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
      orderDate: PAST_DAY,
    },
  });
  return DispatchService.assignOrder(document.id, driverId);
}

async function finish(id: string, status: 'DELIVERED' | 'CANCELLED') {
  await prisma.delivery.update({
    where: { id },
    data: { status, completedAt: new Date('2026-08-14T16:00:00Z'), deliveryPhotoUrl: '/uploads/pod.jpg' },
  });
}

describe('finished stops are history (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let apUser: SessionUser;
  let admin: SessionUser;
  let owner: SessionUser;
  let driverUser: SessionUser;
  let driverId: string;

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "OrderDocument", "Order", "Driver", "User", "Delivery" RESTART IDENTITY CASCADE'
    );
    apUser = await seedUser('AP_USER');
    admin = await seedUser('ADMIN');
    owner = await seedUser('OWNER');
    driverUser = await seedUser('DRIVER');
    driverId = (await prisma.driver.create({
      data: { name: 'Driver', phone: '519-555-0300', userId: driverUser.id },
    })).id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('refuses an AP user a delivered or cancelled stop with 403, and changes nothing', async () => {
    const delivered = await seedStop('9900-000001', driverId);
    const cancelled = await seedStop('9900-000002', driverId);
    await finish(delivered.id, 'DELIVERED');
    await finish(cancelled.id, 'CANCELLED');
    const historyBefore = await prisma.deliveryHistory.count();

    for (const [stop, target] of [[delivered, 'IN_TRANSIT'], [cancelled, 'PLACED'], [delivered, 'CANCELLED']] as const) {
      const res = await patchStatus(apUser, stop.id, target);
      assert.equal(res.statusCode, 403, `${stop.id} -> ${target}`);
      assert.equal(res.body.code, 'FINISHED_STOP_ADMIN_ONLY');
      assert.match(res.body.error, /admin or owner/);
    }

    assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { id: delivered.id } })).status, 'DELIVERED');
    assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { id: cancelled.id } })).status, 'CANCELLED');
    assert.equal(await prisma.deliveryHistory.count(), historyBefore, 'no history written');
  });

  it('lets an admin or owner past the guard, to the state machine that has no way out of a finished state', async () => {
    const delivered = await seedStop('9900-000001', driverId);
    await finish(delivered.id, 'DELIVERED');

    for (const user of [admin, owner]) {
      const res = await patchStatus(user, delivered.id, 'IN_TRANSIT');
      assert.equal(res.statusCode, 409, user.role);
      assert.equal(res.body.code, 'TERMINAL_STATE');
    }
    assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { id: delivered.id } })).status, 'DELIVERED');
  });

  it('lets the office change an unfinished stop due on an earlier day (Carried over work)', async () => {
    const stop = await seedStop('9900-000001', driverId);

    const held = await patchStatus(apUser, stop.id, 'ON_HOLD');
    assert.equal(held.statusCode, 200);
    assert.equal(held.body.status, 'ON_HOLD');

    const back = await patchStatus(apUser, stop.id, 'PLACED');
    assert.equal(back.statusCode, 200);
    assert.equal(back.body.status, 'PLACED');
  });

  it('lets a driver work their unfinished past-dated current stop, and still holds them to it', async () => {
    const current = await seedStop('9900-000001', driverId);
    const done = await seedStop('9900-000002', driverId);
    await finish(done.id, 'DELIVERED');

    const started = await patchStatus(driverUser, current.id, 'IN_TRANSIT');
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.status, 'IN_TRANSIT');

    // The current-stop rule from #60, unchanged: a finished stop is never current.
    const refused = await patchStatus(driverUser, done.id, 'IN_TRANSIT');
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.code, 'DELIVERY_NOT_CURRENT');
  });

  it('refuses an AP user a photo on a finished stop, and lets admins and unfinished stops through', async () => {
    const delivered = await seedStop('9900-000001', driverId);
    const open = await seedStop('9900-000002', driverId);
    await finish(delivered.id, 'DELIVERED');

    const refused = await postPhoto(apUser, delivered.id);
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.body.code, 'FINISHED_STOP_ADMIN_ONLY');

    // Past the guard, each reaches the file check: no file was sent.
    assert.equal((await postPhoto(admin, delivered.id)).statusCode, 400);
    assert.equal((await postPhoto(apUser, open.id)).statusCode, 400);

    assert.equal(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: delivered.id } })).deliveryPhotoUrl,
      '/uploads/pod.jpg',
    );
  });
});
