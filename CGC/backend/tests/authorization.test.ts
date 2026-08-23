import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveActiveUser,
  canAccessDelivery,
  findDriverIdForUser,
  resolveDriverDeliveriesScope,
  type SessionUser,
} from '../src/services/authorization.js';
import { requireRole } from '../src/middleware/authMiddleware.js';

const AP: SessionUser = { id: 'user-ap', email: 'ap@example.test', role: 'AP_USER' };
const OWNER: SessionUser = { id: 'user-owner', email: 'owner@example.test', role: 'OWNER' };
const ADMIN: SessionUser = { id: 'user-admin', email: 'admin@example.test', role: 'ADMIN' };
const DRIVER_A: SessionUser = { id: 'user-driver-a', email: 'a@example.test', role: 'DRIVER' };
const DRIVER_B: SessionUser = { id: 'user-driver-b', email: 'b@example.test', role: 'DRIVER' };

/** Stub client backed by plain fixtures, so no database is involved. */
function stubClient(options: {
  users?: Array<{ id: string; email: string; role: string; active: boolean }>;
  drivers?: Array<{ id: string; userId: string }>;
  deliveries?: Array<{ id: string; driverId: string }>;
} = {}) {
  const users = options.users ?? [];
  const drivers = options.drivers ?? [];
  const deliveries = options.deliveries ?? [];

  return {
    user: {
      async findUnique(args: any) {
        return users.find((u) => u.id === args.where.id) ?? null;
      },
    },
    driver: {
      async findUnique(args: any) {
        const found = drivers.find((d) => d.userId === args.where.userId);
        return found ? { id: found.id } : null;
      },
    },
    delivery: {
      async findFirst(args: any) {
        const ownerUserId = args.where.driver?.userId;
        const found = deliveries.find((d) => {
          if (ownerUserId === undefined) return true;
          const driver = drivers.find((dr) => dr.id === d.driverId);
          return driver?.userId === ownerUserId;
        });
        return found ? { id: found.id } : null;
      },
    },
  };
}

describe('resolveActiveUser', () => {
  it('returns the session identity for an active account', async () => {
    const client = stubClient({
      users: [{ id: 'user-ap', email: 'ap@example.test', role: 'AP_USER', active: true }],
    });
    assert.deepEqual(await resolveActiveUser(client, 'user-ap'), AP);
  });

  it('denies a deactivated account even with a validly signed token', async () => {
    const client = stubClient({
      users: [{ id: 'user-ap', email: 'ap@example.test', role: 'AP_USER', active: false }],
    });
    assert.equal(await resolveActiveUser(client, 'user-ap'), null);
  });

  it('denies a token naming a user that no longer exists', async () => {
    assert.equal(await resolveActiveUser(stubClient(), 'deleted-user'), null);
  });

  it('takes the role from the database, not from the token claim', async () => {
    // A token minted while the user was ADMIN must not keep admin rights after
    // the account is demoted, for the remainder of its 7-day lifetime.
    const client = stubClient({
      users: [{ id: 'user-x', email: 'x@example.test', role: 'DRIVER', active: true }],
    });
    const resolved = await resolveActiveUser(client, 'user-x');
    assert.equal(resolved?.role, 'DRIVER');
  });
});

describe('canAccessDelivery', () => {
  const client = stubClient({
    drivers: [
      { id: 'driver-a', userId: 'user-driver-a' },
      { id: 'driver-b', userId: 'user-driver-b' },
    ],
    deliveries: [
      { id: 'delivery-a1', driverId: 'driver-a' },
      { id: 'delivery-a2', driverId: 'driver-a' },
      { id: 'delivery-b1', driverId: 'driver-b' },
    ],
  });

  it('denies an anonymous caller', async () => {
    assert.equal(await canAccessDelivery(client, undefined, 'delivery-a1'), false);
  });

  it('allows a driver to act on its own delivery', async () => {
    assert.equal(await canAccessDelivery(client, DRIVER_A, 'delivery-a1'), true);
  });

  it("denies a driver acting on another driver's delivery", async () => {
    assert.equal(await canAccessDelivery(client, DRIVER_A, 'delivery-b1'), false);
    assert.equal(await canAccessDelivery(client, DRIVER_B, 'delivery-a1'), false);
  });

  it('denies a later stop assigned to the same driver', async () => {
    assert.equal(await canAccessDelivery(client, DRIVER_A, 'delivery-a2'), false);
  });

  it('denies a driver acting on a delivery that does not exist', async () => {
    assert.equal(await canAccessDelivery(client, DRIVER_A, 'delivery-missing'), false);
  });

  it('allows operations roles on any delivery', async () => {
    for (const user of [AP, OWNER, ADMIN]) {
      assert.equal(await canAccessDelivery(client, user, 'delivery-a1'), true);
      assert.equal(await canAccessDelivery(client, user, 'delivery-b1'), true);
    }
  });
});

describe('findDriverIdForUser', () => {
  const client = stubClient({ drivers: [{ id: 'driver-a', userId: 'user-driver-a' }] });

  it('resolves the linked driver profile', async () => {
    assert.equal(await findDriverIdForUser(client, 'user-driver-a'), 'driver-a');
  });

  it('returns null when no driver profile is linked', async () => {
    assert.equal(await findDriverIdForUser(client, 'user-ap'), null);
  });
});

describe('resolveDriverDeliveriesScope', () => {
  const client = stubClient({
    drivers: [
      { id: 'driver-a', userId: 'user-driver-a' },
      { id: 'driver-b', userId: 'user-driver-b' },
    ],
  });

  it('denies an anonymous caller', async () => {
    assert.deepEqual(await resolveDriverDeliveriesScope(client, undefined, 'driver-a'), {
      allowed: false,
    });
  });

  it('lets a driver read its own deliveries', async () => {
    assert.deepEqual(await resolveDriverDeliveriesScope(client, DRIVER_A, 'driver-a'), {
      allowed: true,
      driverId: 'driver-a',
    });
  });

  it("denies a driver reading another driver's deliveries", async () => {
    assert.deepEqual(await resolveDriverDeliveriesScope(client, DRIVER_A, 'driver-b'), {
      allowed: false,
    });
  });

  it('denies a driver with no linked profile', async () => {
    const orphan: SessionUser = { id: 'user-orphan', email: 'o@example.test', role: 'DRIVER' };
    assert.deepEqual(await resolveDriverDeliveriesScope(client, orphan, 'driver-a'), {
      allowed: false,
    });
  });

  it('keeps the requested id for operations roles', async () => {
    for (const user of [AP, OWNER, ADMIN]) {
      assert.deepEqual(await resolveDriverDeliveriesScope(client, user, 'driver-b'), {
        allowed: true,
        driverId: 'driver-b',
      });
    }
  });
});

/** Minimal Express response double capturing status and body. */
function responseDouble() {
  const captured: { status?: number; body?: unknown } = {};
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

describe('requireRole', () => {
  const opsOnly = requireRole(['AP_USER', 'OWNER', 'ADMIN']);

  it('rejects an unauthenticated request with 401', () => {
    const { res, captured } = responseDouble();
    let advanced = false;
    opsOnly({} as any, res, () => { advanced = true; });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('rejects a DRIVER from AP/admin functionality with 403', () => {
    const { res, captured } = responseDouble();
    let advanced = false;
    opsOnly({ user: DRIVER_A } as any, res, () => { advanced = true; });
    assert.equal(captured.status, 403);
    assert.equal(advanced, false);
  });

  it('admits each intended operations role', () => {
    for (const user of [AP, OWNER, ADMIN]) {
      const { res, captured } = responseDouble();
      let advanced = false;
      opsOnly({ user } as any, res, () => { advanced = true; });
      assert.equal(advanced, true, `${user.role} should be admitted`);
      assert.equal(captured.status, undefined);
    }
  });

  it('rejects AP_USER from an owner/admin-only guard', () => {
    const adminOnly = requireRole(['OWNER', 'ADMIN']);
    const { res, captured } = responseDouble();
    let advanced = false;
    adminOnly({ user: AP } as any, res, () => { advanced = true; });
    assert.equal(captured.status, 403);
    assert.equal(advanced, false);
  });

  it('publishes the roles it admits', () => {
    assert.deepEqual([...opsOnly.allowedRoles], ['AP_USER', 'OWNER', 'ADMIN']);
  });
});
