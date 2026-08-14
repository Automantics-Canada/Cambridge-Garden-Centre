/**
 * Delivery state machine tests.
 *
 * `PATCH /deliveries/:id/status` wrote `req.body.status` straight through. The
 * ownership check (`canAccessDelivery`) stopped one driver touching another
 * driver's stop, but nothing constrained *which* state was written — so an
 * assigned driver could cancel work, re-open a DELIVERED stop, or complete a
 * delivery that had never started and had no proof attached.
 *
 * These exercise `evaluateTransition` directly. It is pure and takes the
 * delivery record as a parameter, so every allow/deny branch runs without a
 * database — the same approach `authorization.test.ts` takes.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeliveryStatus, UserRole } from '@prisma/client';
import {
  evaluateTransition,
  isDeliveryStatus,
  DELIVERY_TRANSITIONS,
  TERMINAL_STATUSES,
  DRIVER_ALLOWED_TARGETS,
  DENIAL_HTTP_STATUS,
} from '../src/modules/deliveries/deliveryTransitions.js';

const NO_PHOTOS = { pickupPhotoUrl: null, deliveryPhotoUrl: null };
const WITH_DELIVERY_PHOTO = { pickupPhotoUrl: null, deliveryPhotoUrl: '/uploads/pod.jpg' };

function attempt(
  from: DeliveryStatus,
  to: unknown,
  role: UserRole = 'ADMIN',
  evidence = WITH_DELIVERY_PHOTO
) {
  return evaluateTransition({ from, to, role, evidence });
}

describe('isDeliveryStatus', () => {
  it('accepts every enum member', () => {
    for (const status of Object.keys(DELIVERY_TRANSITIONS)) {
      assert.equal(isDeliveryStatus(status), true, `${status} should be valid`);
    }
  });

  it('rejects anything else', () => {
    for (const bad of ['delivered', 'DONE', '', null, undefined, 42, {}, ['DELIVERED']]) {
      assert.equal(isDeliveryStatus(bad), false, `${String(bad)} should be invalid`);
    }
  });
});

describe('the happy path the apps actually drive', () => {
  it('lets dispatch assign an unassigned delivery', () => {
    assert.equal(attempt('UNASSIGNED', 'PLACED').allowed, true);
  });

  it('lets a driver start its own placed delivery', () => {
    assert.equal(attempt('PLACED', 'IN_TRANSIT', 'DRIVER').allowed, true);
  });

  it('lets a driver complete with proof attached', () => {
    const result = attempt('IN_TRANSIT', 'DELIVERED', 'DRIVER', WITH_DELIVERY_PHOTO);
    assert.equal(result.allowed, true);
  });

  it('lets a driver flag a problem', () => {
    assert.equal(attempt('IN_TRANSIT', 'DELAYED', 'DRIVER').allowed, true);
    assert.equal(attempt('IN_TRANSIT', 'ON_HOLD', 'DRIVER').allowed, true);
  });
});

describe('invalid status values', () => {
  it('rejects an unknown string with 400', () => {
    const result = attempt('PLACED', 'COMPLETED');
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.code, 'INVALID_STATUS');
    assert.equal(DENIAL_HTTP_STATUS.INVALID_STATUS, 400);
  });

  it('rejects non-strings rather than coercing them', () => {
    for (const bad of [null, undefined, 7, {}, true]) {
      const result = attempt('PLACED', bad);
      assert.equal(result.allowed, false, `${String(bad)} must be refused`);
      assert.equal(result.allowed === false && result.code, 'INVALID_STATUS');
    }
  });
});

describe('terminal states', () => {
  for (const terminal of TERMINAL_STATUSES) {
    it(`refuses to move out of ${terminal}`, () => {
      for (const target of Object.keys(DELIVERY_TRANSITIONS) as DeliveryStatus[]) {
        if (target === terminal) continue;
        const result = attempt(terminal, target);
        assert.equal(result.allowed, false, `${terminal} -> ${target} must be refused`);
        assert.equal(result.allowed === false && result.code, 'TERMINAL_STATE');
      }
    });
  }

  it('will not re-open a delivered stop even for an admin', () => {
    const result = attempt('DELIVERED', 'IN_TRANSIT', 'ADMIN');
    assert.equal(result.allowed, false);
    assert.equal(DENIAL_HTTP_STATUS.TERMINAL_STATE, 409);
  });

  it('will not resurrect a cancelled delivery', () => {
    assert.equal(attempt('CANCELLED', 'PLACED', 'ADMIN').allowed, false);
  });
});

describe('illegal jumps', () => {
  it('refuses unassigned straight to delivered', () => {
    const result = attempt('UNASSIGNED', 'DELIVERED');
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.code, 'ILLEGAL_TRANSITION');
  });

  it('refuses a no-op repeat so history is not padded', () => {
    const result = attempt('IN_TRANSIT', 'IN_TRANSIT');
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.code, 'ILLEGAL_TRANSITION');
  });

  it('refuses every pairing the matrix does not list', () => {
    for (const from of Object.keys(DELIVERY_TRANSITIONS) as DeliveryStatus[]) {
      for (const to of Object.keys(DELIVERY_TRANSITIONS) as DeliveryStatus[]) {
        const listed = DELIVERY_TRANSITIONS[from].includes(to);
        const result = attempt(from, to, 'ADMIN', WITH_DELIVERY_PHOTO);
        if (!listed) {
          assert.equal(result.allowed, false, `${from} -> ${to} is not in the matrix`);
        }
      }
    }
  });
});

describe('DRIVER restrictions', () => {
  it('a driver may not cancel work', () => {
    const result = attempt('IN_TRANSIT', 'CANCELLED', 'DRIVER');
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.code, 'ROLE_NOT_PERMITTED');
    assert.equal(DENIAL_HTTP_STATUS.ROLE_NOT_PERMITTED, 403);
  });

  it('a driver may not un-assign a delivery', () => {
    const result = attempt('PLACED', 'UNASSIGNED', 'DRIVER');
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.code, 'ROLE_NOT_PERMITTED');
  });

  it('operations roles may cancel from any live state', () => {
    for (const role of ['OWNER', 'ADMIN'] as UserRole[]) {
      for (const from of ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT'] as DeliveryStatus[]) {
        assert.equal(attempt(from, 'CANCELLED', role).allowed, true, `${role} ${from}`);
      }
    }
  });

  it('every driver-allowed target is reachable by a driver from some state', () => {
    // Guards the matrix and the driver list against drifting apart: a target a
    // driver is permitted to set but can never legally reach is dead config.
    for (const target of DRIVER_ALLOWED_TARGETS) {
      const reachable = (Object.keys(DELIVERY_TRANSITIONS) as DeliveryStatus[]).some(
        (from) =>
          evaluateTransition({
            from,
            to: target,
            role: 'DRIVER',
            evidence: WITH_DELIVERY_PHOTO,
          }).allowed
      );
      assert.equal(reachable, true, `no state lets a driver reach ${target}`);
    }
  });
});

describe('required proof of delivery', () => {
  it('refuses DELIVERED with no delivery photo', () => {
    const result = attempt('IN_TRANSIT', 'DELIVERED', 'DRIVER', NO_PHOTOS);
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.code, 'MISSING_EVIDENCE');
    assert.equal(DENIAL_HTTP_STATUS.MISSING_EVIDENCE, 422);
  });

  it('refuses DELIVERED without proof for admins too', () => {
    assert.equal(attempt('IN_TRANSIT', 'DELIVERED', 'ADMIN', NO_PHOTOS).allowed, false);
  });

  it('allows DELIVERED once the photo exists', () => {
    assert.equal(attempt('IN_TRANSIT', 'DELIVERED', 'DRIVER', WITH_DELIVERY_PHOTO).allowed, true);
  });

  it('does not require a pickup photo to go IN_TRANSIT', () => {
    // The driver app enters IN_TRANSIT first and uploads the pickup photo
    // afterwards. Requiring it here would break the real sequence.
    assert.equal(attempt('PLACED', 'IN_TRANSIT', 'DRIVER', NO_PHOTOS).allowed, true);
  });

  it('does not gate non-terminal states on evidence', () => {
    for (const target of ['ON_HOLD', 'DELAYED'] as DeliveryStatus[]) {
      assert.equal(attempt('IN_TRANSIT', target, 'DRIVER', NO_PHOTOS).allowed, true);
    }
  });
});

describe('denial precedence', () => {
  it('reports a forbidden role before asking for evidence', () => {
    // A driver cancelling should be told it is forbidden, not asked for a photo.
    const result = attempt('IN_TRANSIT', 'CANCELLED', 'DRIVER', NO_PHOTOS);
    assert.equal(result.allowed === false && result.code, 'ROLE_NOT_PERMITTED');
  });

  it('reports an invalid value before anything else', () => {
    const result = attempt('DELIVERED', 'NONSENSE', 'DRIVER', NO_PHOTOS);
    assert.equal(result.allowed === false && result.code, 'INVALID_STATUS');
  });

  it('reports a terminal source before an illegal pairing', () => {
    const result = attempt('CANCELLED', 'DELIVERED', 'DRIVER', NO_PHOTOS);
    assert.equal(result.allowed === false && result.code, 'TERMINAL_STATE');
  });
});

describe('matrix integrity', () => {
  it('covers every enum member as a source', () => {
    const sources = Object.keys(DELIVERY_TRANSITIONS).sort();
    assert.deepEqual(
      sources,
      [
        'CANCELLED', 'DELAYED', 'DELIVERED', 'IN_TRANSIT',
        'ON_HOLD', 'OUT_FOR_DELIVERY', 'PLACED', 'UNASSIGNED',
      ],
      'a new DeliveryStatus was added without a transition rule'
    );
  });

  it('never lists a target that is not a real status', () => {
    for (const [from, targets] of Object.entries(DELIVERY_TRANSITIONS)) {
      for (const target of targets) {
        assert.equal(isDeliveryStatus(target), true, `${from} -> ${target}`);
      }
    }
  });

  it('never lets a state transition to itself', () => {
    for (const [from, targets] of Object.entries(DELIVERY_TRANSITIONS)) {
      assert.equal(targets.includes(from as DeliveryStatus), false, `${from} -> ${from}`);
    }
  });

  it('gives terminal states no outbound transitions', () => {
    for (const terminal of TERMINAL_STATUSES) {
      assert.deepEqual(DELIVERY_TRANSITIONS[terminal], []);
    }
  });
});
