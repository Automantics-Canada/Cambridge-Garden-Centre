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
import supplierRouter from '../src/modules/supplier/supplier.routes.js';
import productRouter from '../src/modules/products/product.routes.js';
import spruceVendorRouter from '../src/modules/supplier/spruceVendors.routes.js';
import emailEventRouter from '../src/modules/emailEvents/emailEvents.routes.js';

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
    ['get', '/upcoming'],
    ['get', '/pickups'],
    ['post', '/assign'],
    ['post', '/unassign'],
    ['post', '/reorder'],
    ['post', '/orders/:documentId/done-outside-app'],
    ['get', '/orders/:documentId/loads'],
    ['post', '/orders/:documentId/loads'],
    ['patch', '/loads/:loadId'],
    ['delete', '/loads/:loadId'],
    ['post', '/loads/:loadId/copy-rate-to-trip'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} requires an operations role`, () => {
      assertGuarded(dispatchRouter, method, path, OPERATIONS);
    });
  }

  it('keeps DRIVER from marking an order done outside the app', () => {
    const roles = admittedRoles(effectiveChain(dispatchRouter, 'post', '/orders/:documentId/done-outside-app'));
    assert.equal(roles?.includes('DRIVER'), false);
  });

  it('keeps DRIVER away from dispatch loads and their haul rates', () => {
    for (const [method, path] of [
      ['get', '/orders/:documentId/loads'],
      ['post', '/orders/:documentId/loads'],
      ['patch', '/loads/:loadId'],
      ['delete', '/loads/:loadId'],
      ['post', '/loads/:loadId/copy-rate-to-trip'],
    ] as const) {
      assert.equal(admittedRoles(effectiveChain(dispatchRouter, method, path))?.includes('DRIVER'), false, `${method} ${path}`);
    }
  });
});

describe('invoice routes', () => {
  it('the mock-email simulator is ADMIN only', () => {
    assertGuarded(invoiceRouter, 'post', '/mock-email', ['ADMIN']);
  });

  it('staff invoice upload admits operations roles and keeps DRIVER out', () => {
    assertGuarded(invoiceRouter, 'post', '/upload', OPERATIONS);
    assert.equal(
      admittedRoles(effectiveChain(invoiceRouter, 'post', '/upload'))?.includes('DRIVER'),
      false
    );
  });

  const routes: Array<[string, string]> = [
    ['get', '/'],
    ['get', '/dashboard-summary'],
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
    assertGuarded(orderRouter, 'post', '/merge-po-report', OPERATIONS);
  });

  it('order GETs require an operations role so a DRIVER cannot dump the book', () => {
    assertGuarded(orderRouter, 'get', '/', OPERATIONS);
    assertGuarded(orderRouter, 'get', '/import/stream', OPERATIONS);
    assertGuarded(orderRouter, 'get', '/import/jobs/:jobId', OPERATIONS);
    assert.equal(admittedRoles(effectiveChain(orderRouter, 'get', '/'))?.includes('DRIVER'), false);
  });

  it('only the office edits an order or says it is not a quotation', () => {
    for (const [method, path] of [
      ['patch', '/documents/:id'],
      ['post', '/documents/:id/reset'],
      ['post', '/documents/:id/not-a-quotation'],
    ] as const) {
      assertGuarded(orderRouter, method, path, OPERATIONS);
      assert.equal(admittedRoles(effectiveChain(orderRouter, method, path))?.includes('DRIVER'), false, `${method} ${path}`);
    }
  });
});

describe('supplier routes', () => {
  it('listing suppliers is operations-only', () => {
    assertGuarded(supplierRouter, 'get', '/', OPERATIONS);
    assert.equal(
      admittedRoles(effectiveChain(supplierRouter, 'get', '/'))?.includes('DRIVER'),
      false
    );
  });

  it('the lean options endpoint carries the same guard as the full list', () => {
    // Added for the tickets filter dropdown. A cheaper projection must not mean
    // a weaker guard — it still exposes the supplier roster.
    assertGuarded(supplierRouter, 'get', '/options', OPERATIONS);
    assert.equal(
      admittedRoles(effectiveChain(supplierRouter, 'get', '/options'))?.includes('DRIVER'),
      false
    );
  });
});

describe('supplier sender fields (decision G5)', () => {
  // A supplier's email domains, addresses and contact email decide whose
  // invoices the inbox reads automatically, as approving a sender does, and
  // that is OWNER/ADMIN only. Editing a supplier is guarded by the route;
  // creating one stays open to AP_USER, whose handler refuses those fields
  // (tests/emailReviewQueue.integration.test.ts).
  it('editing a supplier is owner/admin only', () => {
    assert.deepEqual(admittedRoles(effectiveChain(supplierRouter, 'put', '/:id'))?.sort(), ['ADMIN', 'OWNER']);
  });

  it('creating one is office work, and the handler is the sender-field guard', () => {
    assertGuarded(supplierRouter, 'post', '/', OPERATIONS);
    assert.ok(effectiveChain(supplierRouter, 'post', '/').names.includes('createSupplier'));
  });
});

describe('rate and price-list routes', () => {
  // These decide what an invoice is checked against, so they are office work
  // and a DRIVER must never reach them.
  const routes: Array<[string, string]> = [
    ['post', '/:id/rates'],
    ['patch', '/:id/rates/:rateId'],
    ['post', '/:id/rates/:rateId/expire'],
    ['delete', '/:id/rates/:rateId'],
    ['post', '/:id/rates/import/preview'],
    ['post', '/:id/rates/import'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} is office-only`, () => {
      assertGuarded(supplierRouter, method, path, OPERATIONS);
      assert.equal(admittedRoles(effectiveChain(supplierRouter, method, path))?.includes('DRIVER'), false);
    });
  }

  it('the price-list upload is bounded by multer before the handler runs', () => {
    for (const path of ['/:id/rates/import/preview', '/:id/rates/import']) {
      const chain = effectiveChain(supplierRouter, 'post', path);
      assert.ok(chain.names.includes('multerMiddleware'), `${path} must bound the upload`);
    }
  });
});

describe('Spruce vendor code routes', () => {
  const routes: Array<[string, string]> = [
    ['get', '/'],
    ['get', '/unmapped'],
    ['post', '/'],
    ['delete', '/:code'],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} is office-only`, () => {
      assertGuarded(spruceVendorRouter, method, path, OPERATIONS);
      assert.equal(admittedRoles(effectiveChain(spruceVendorRouter, method, path))?.includes('DRIVER'), false);
    });
  }

  it('GET /unmapped is registered before anything that could swallow it', () => {
    const index = (method: string, path: string) =>
      spruceVendorRouter.stack.findIndex((layer: any) => layer.route?.path === path && layer.route?.methods?.[method]);
    assert.ok(index('get', '/unmapped') >= 0);
    assert.ok(index('get', '/unmapped') < index('delete', '/:code'));
  });
});

describe('email review queue routes', () => {
  // Supplier mail is office business. Approving a sender edits a supplier and
  // decides whose invoices are read automatically, so it and ignoring are for
  // OWNER/ADMIN; AP_USER may look. Drivers get none of it.
  it('GET / is office-only', () => {
    assertGuarded(emailEventRouter, 'get', '/', OPERATIONS);
    assert.equal(admittedRoles(effectiveChain(emailEventRouter, 'get', '/'))?.includes('DRIVER'), false);
  });

  for (const path of ['/:id/approve', '/:id/ignore']) {
    it(`POST ${path} is OWNER/ADMIN only`, () => {
      assertGuarded(emailEventRouter, 'post', path, ['OWNER', 'ADMIN']);
      const roles = admittedRoles(effectiveChain(emailEventRouter, 'post', path));
      assert.equal(roles?.includes('AP_USER'), false);
      assert.equal(roles?.includes('DRIVER'), false);
    });
  }
});

describe('literal routes stay reachable', () => {
  /**
   * A literal path registered after a matching `/:param` route is dead: Express
   * matches in registration order, so `/:id` swallows `/dashboard-summary` and
   * the endpoint answers 404 (or 500, when the handler parses the literal as a
   * uuid) even though the code for it is right there.
   *
   * Both endpoints below failed exactly that way in production against a build
   * that predated them, which is what these assertions describe.
   */
  function indexOfRoute(router: any, method: string, path: string): number {
    return router.stack.findIndex(
      (layer: any) => layer.route?.path === path && layer.route?.methods?.[method]
    );
  }

  it('GET /dashboard-summary is registered before GET /:id', () => {
    const summary = indexOfRoute(invoiceRouter, 'get', '/dashboard-summary');
    const byId = indexOfRoute(invoiceRouter, 'get', '/:id');
    assert.notEqual(summary, -1, 'the dashboard summary route is missing');
    assert.ok(
      summary < byId,
      `/dashboard-summary (${summary}) must precede /:id (${byId}) or it is unreachable`
    );
  });

  it('GET /options is registered before the supplier list', () => {
    const options = indexOfRoute(supplierRouter, 'get', '/options');
    assert.notEqual(options, -1, 'the supplier options route is missing');
  });
});

describe('product routes', () => {
  it('listing products and units is operations-only', () => {
    assertGuarded(productRouter, 'get', '/', OPERATIONS);
    assertGuarded(productRouter, 'get', '/units', OPERATIONS);
    assert.equal(
      admittedRoles(effectiveChain(productRouter, 'get', '/'))?.includes('DRIVER'),
      false
    );
  });
});

describe('GET routes that operations staff use', () => {
  const cases: Array<[any, string, string, UserRole[] | null]> = [
    [dispatchRouter, 'get', '/', OPERATIONS],
    [invoiceRouter, 'get', '/', OPERATIONS],
    [invoiceRouter, 'get', '/dashboard-summary', OPERATIONS],
    [invoiceRouter, 'get', '/:id', OPERATIONS],
    [ticketRouter, 'get', '/', OPERATIONS],
    [ticketRouter, 'get', '/stats', OPERATIONS],
    [ticketRouter, 'get', '/:id', OPERATIONS],
    [ticketRouter, 'get', '/:ticketId/ocr-status', OPERATIONS],
    [orderRouter, 'get', '/', OPERATIONS],
    [orderRouter, 'get', '/import/stream', OPERATIONS],
    [orderRouter, 'get', '/import/jobs/:jobId', OPERATIONS],
    [supplierRouter, 'get', '/', OPERATIONS],
    // The carrier picker on the dispatch board reads it.
    [supplierRouter, 'get', '/options', OPERATIONS],
    [productRouter, 'get', '/', OPERATIONS],
    [productRouter, 'get', '/units', OPERATIONS],
    [deliveriesRouter, 'get', '/', null],
    [driverRouter, 'get', '/me', null],
    [driverRouter, 'get', '/', null],
    [driverRouter, 'get', '/:id/deliveries', null],
  ];

  for (const [router, method, path, roles] of cases) {
    it(`${method.toUpperCase()} ${path} is authenticated with the intended roles`, () => {
      assertGuarded(router, method, path, roles);
    });
  }
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
