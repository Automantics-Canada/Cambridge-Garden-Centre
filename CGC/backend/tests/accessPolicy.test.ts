/**
 * Regression tests for the fetch-cgc-data Edge Function resource policy.
 *
 * The stabilization branch had restricted every resource except `drivers-me`
 * to operations roles, which returned 403 for the driver mobile view's
 * `resource=deliveries` request and disabled the whole driver workflow. These
 * tests pin both halves of the corrected behaviour: a driver can reach its own
 * deliveries, and the scope is forced to come from the verified token subject.
 *
 * The policy module is imported straight from supabase/functions/_shared so the
 * deployed edge code and these assertions cannot drift apart.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canAccessResource,
  requiresOwnDriverScope,
  isOperationsRole,
} from '../../supabase/functions/_shared/accessPolicy.ts';

const OPERATIONS = ['AP_USER', 'OWNER', 'ADMIN'] as const;

const ALL_RESOURCES = [
  'dashboard-summary',
  'tickets',
  'orders',
  'invoices',
  'invoice-details',
  'drivers',
  'drivers-me',
  'suppliers',
  'products',
  'deliveries',
  'dispatch-board',
] as const;

describe('isOperationsRole', () => {
  it('recognises the operations roles', () => {
    for (const role of OPERATIONS) {
      assert.equal(isOperationsRole(role), true, role);
    }
  });

  it('rejects DRIVER, unknown and missing roles', () => {
    for (const role of ['DRIVER', 'SUPERUSER', '', null, undefined]) {
      assert.equal(isOperationsRole(role as any), false, String(role));
    }
  });
});

describe('canAccessResource', () => {
  it('admits every resource for operations roles', () => {
    for (const role of OPERATIONS) {
      for (const resource of ALL_RESOURCES) {
        assert.equal(canAccessResource(role, resource), true, `${role} -> ${resource}`);
      }
    }
  });

  it('admits a DRIVER to its own profile and its deliveries', () => {
    assert.equal(canAccessResource('DRIVER', 'drivers-me'), true);
    assert.equal(canAccessResource('DRIVER', 'deliveries'), true);
  });

  it('denies a DRIVER every AP and administrative resource', () => {
    const denied = ALL_RESOURCES.filter((r) => r !== 'drivers-me' && r !== 'deliveries');
    for (const resource of denied) {
      assert.equal(canAccessResource('DRIVER', resource), false, resource);
    }
    // Named explicitly so a future edit to ALL_RESOURCES cannot quietly drop
    // the cases that matter most.
    for (const resource of ['invoices', 'dashboard-summary', 'drivers', 'dispatch-board']) {
      assert.equal(canAccessResource('DRIVER', resource), false, resource);
    }
  });

  it('denies unknown roles everything', () => {
    for (const resource of ALL_RESOURCES) {
      assert.equal(canAccessResource('SUPERUSER', resource), false, resource);
      assert.equal(canAccessResource(null, resource), false, resource);
    }
  });

  it('denies a missing or empty resource', () => {
    for (const role of [...OPERATIONS, 'DRIVER']) {
      assert.equal(canAccessResource(role, null), false);
      assert.equal(canAccessResource(role, ''), false);
    }
  });
});

describe('requiresOwnDriverScope', () => {
  it('forces own-driver scope for a DRIVER reading deliveries', () => {
    assert.equal(requiresOwnDriverScope('DRIVER', 'deliveries'), true);
  });

  it('leaves operations roles free to filter by any driver', () => {
    for (const role of OPERATIONS) {
      assert.equal(requiresOwnDriverScope(role, 'deliveries'), false, role);
    }
  });

  it('does not apply to other resources', () => {
    assert.equal(requiresOwnDriverScope('DRIVER', 'drivers-me'), false);
    assert.equal(requiresOwnDriverScope('DRIVER', 'invoices'), false);
  });

  it('applies to any non-operations role, not only DRIVER', () => {
    // Fail closed: a role added later must be pinned until it is explicitly
    // classified as operations.
    assert.equal(requiresOwnDriverScope('SUPERUSER', 'deliveries'), true);
  });
});
