/**
 * Route-wiring regression tests.
 *
 * The security findings this branch addresses were all "the guard is missing
 * from this route", not "the guard is wrong". Unit-testing requireRole cannot
 * catch that class of defect, so these tests inspect the actual Express router
 * stacks and assert which middleware each endpoint really runs.
 *
 * Router-level `router.use(...)` middleware only protects routes registered
 * after it, so the effective chain is computed the same way Express resolves it
 * at request time: router-level layers that appear before the route's own layer,
 * followed by the route's handlers. That makes the test fail if someone moves a
 * `router.use` guard below the routes it was meant to protect.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UserRole } from '../src/middleware/authMiddleware.js';

import deliveriesRouter from '../src/modules/deliveries/deliveries.routes.js';
import dispatchRouter from '../src/modules/dispatch/dispatch.routes.js';
import driverRouter from '../src/modules/drivers/driver.routes.js';
import invoiceRouter from '../src/modules/invoices/invoice.routes.js';
import ticketRouter from '../src/modules/tickets/ticket.routes.js';
import orderRouter from '../src/modules/orders/order.routes.js';
import authRouter from '../src/modules/auth/auth.routes.js';

const OPERATIONS: UserRole[] = ['AP_USER', 'OWNER', 'ADMIN'];

interface EffectiveChain {
  handlers: Function[];
  names: string[];
}

/** Resolve the middleware Express would actually run for `method path`. */
function effectiveChain(router: any, method: string, path: string): EffectiveChain {
  const routeIndex = router.stack.findIndex(
    (layer: any) => layer.route?.path === path && layer.route?.methods?.[method]
  );
  assert.notEqual(routeIndex, -1, `route ${method.toUpperCase()} ${path} not found`);

  const handlers: Function[] = [];
  for (let i = 0; i < routeIndex; i++) {
    const layer = router.stack[i];
    if (!layer.route && typeof layer.handle === 'function') {
      handlers.push(layer.handle);
    }
  }
  for (const layer of router.stack[routeIndex].route.stack ?? []) {
    handlers.push(layer.handle);
  }

  return { handlers, names: handlers.map((h) => h.name) };
}

function isAuthenticated(chain: EffectiveChain): boolean {
  return chain.names.includes('authMiddleware');
}

/**
 * Roles the endpoint admits: the intersection of every role guard in the chain.
 * `null` means no role guard is present, i.e. any authenticated role.
 */
function admittedRoles(chain: EffectiveChain): UserRole[] | null {
  const guards = chain.handlers.filter(
    (h: any) => h.name === 'requireRoleMiddleware' && Array.isArray(h.allowedRoles)
  ) as Array<Function & { allowedRoles: UserRole[] }>;

  if (guards.length === 0) return null;

  return guards
    .map((g) => g.allowedRoles)
    .reduce((acc, roles) => acc.filter((role) => roles.includes(role)));
}

function assertGuarded(
  router: any,
  method: string,
  path: string,
  expectedRoles: UserRole[] | null
) {
  const chain = effectiveChain(router, method, path);
  assert.equal(
    isAuthenticated(chain),
    true,
    `${method.toUpperCase()} ${path} must run authMiddleware — chain: ${chain.names.join(' > ')}`
  );
  const roles = admittedRoles(chain);
  if (expectedRoles === null) {
    assert.equal(roles, null, `${method.toUpperCase()} ${path} unexpectedly restricts roles`);
  } else {
    assert.deepEqual(
      roles?.slice().sort(),
      expectedRoles.slice().sort(),
      `${method.toUpperCase()} ${path} admits the wrong roles`
    );
  }
}

describe('dispatch routes', () => {
  // Every dispatch route was reachable anonymously before stabilization.
  const routes: Array<[string, string]> = [
    ['get', '/'],
    ['post', '/assign'],
    ['post', '/unassign'],
    ['post', '/reorder'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} requires an operations role`, () => {
      assertGuarded(dispatchRouter, method, path, OPERATIONS);
    });
  }
});

describe('invoice routes', () => {
  it('the mock-email simulator is ADMIN only', () => {
    assertGuarded(invoiceRouter, 'post', '/mock-email', ['ADMIN']);
  });

  const routes: Array<[string, string]> = [
    ['get', '/'],
    ['get', '/:id'],
    ['post', '/:id/verify'],
    ['post', '/:id/dispute'],
    ['post', '/:id/reopen'],
    ['post', '/line-items/link-order'],
    ['post', '/line-items/link-tickets'],
    ['post', '/line-items/unlink-order'],
    ['post', '/line-items/unlink-ticket'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} keeps DRIVER out of the invoice ledger`, () => {
      assertGuarded(invoiceRouter, method, path, OPERATIONS);
      assert.equal(admittedRoles(effectiveChain(invoiceRouter, method, path))?.includes('DRIVER'), false);
    });
  }
});

describe('ticket routes', () => {
  const routes: Array<[string, string]> = [
    ['post', '/whatsapp'],
    ['post', '/email'],
    ['post', '/upload'],
    ['post', '/upload-pdf'],
    ['post', '/:id/process-ocr'],
    ['get', '/:ticketId/ocr-status'],
    ['post', '/jobs/process-pending'],
    ['get', '/stats'],
    ['get', '/'],
    ['get', '/:id'],
    ['post', '/:id/link'],
    ['post', '/:id/unlink'],
    ['put', '/:id'],
    ['delete', '/:id'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} requires an operations role`, () => {
      assertGuarded(ticketRouter, method, path, OPERATIONS);
    });
  }
});

describe('driver routes', () => {
  it('driver lifecycle operations are restricted to OWNER and ADMIN', () => {
    assertGuarded(driverRouter, 'post', '/', ['OWNER', 'ADMIN']);
    assertGuarded(driverRouter, 'patch', '/:id', ['OWNER', 'ADMIN']);
    assertGuarded(driverRouter, 'delete', '/:id', ['OWNER', 'ADMIN']);
  });

  it('a DRIVER cannot administer driver accounts', () => {
    for (const [method, path] of [['post', '/'], ['patch', '/:id'], ['delete', '/:id']] as const) {
      const roles = admittedRoles(effectiveChain(driverRouter, method, path));
      assert.equal(roles?.includes('DRIVER'), false, `${method} ${path}`);
      assert.equal(roles?.includes('AP_USER'), false, `${method} ${path}`);
    }
  });

  it('self-service driver routes stay authenticated but unrestricted by role', () => {
    // Ownership for these is enforced in the controller, not by role.
    assertGuarded(driverRouter, 'get', '/me', null);
    assertGuarded(driverRouter, 'get', '/:id/deliveries', null);
  });
});

describe('delivery routes', () => {
  const routes: Array<[string, string]> = [
    ['get', '/'],
    ['patch', '/:id/status'],
    ['post', '/:id/photos'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} is authenticated and open to DRIVER`, () => {
      // Drivers must keep access; cross-driver denial is enforced per record by
      // canAccessDelivery, covered in authorization.test.ts.
      assertGuarded(deliveriesRouter, method, path, null);
    });
  }

  it('the photo upload runs size, type and content validation', () => {
    const chain = effectiveChain(deliveriesRouter, 'post', '/:id/photos');
    assert.ok(chain.names.includes('multerMiddleware'), 'multer must bound the upload');
    assert.equal(
      chain.handlers.length >= 4,
      true,
      `expected rate limit + multer + content validation + handler, got ${chain.names.join(' > ')}`
    );
  });
});

describe('order routes', () => {
  it('imports require an operations role', () => {
    assertGuarded(orderRouter, 'post', '/import', OPERATIONS);
    assertGuarded(orderRouter, 'post', '/import-pdf', OPERATIONS);
  });
});

describe('auth routes', () => {
  it('user creation is ADMIN only and never public', () => {
    assertGuarded(authRouter, 'post', '/register', ['ADMIN']);
  });

  it('login stays public', () => {
    const chain = effectiveChain(authRouter, 'post', '/login');
    assert.equal(isAuthenticated(chain), false, 'login must not require a session');
  });
});
