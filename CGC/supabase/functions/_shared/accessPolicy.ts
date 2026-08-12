// Resource authorization policy for the fetch-cgc-data Edge Function.
//
// This module is deliberately dependency-free so the same source can be loaded
// by Deno at the edge and imported directly by the backend Node test suite.
// Keeping one implementation prevents the edge policy from drifting away from
// the behaviour the regression tests assert.

export type SessionRole = 'AP_USER' | 'OWNER' | 'ADMIN' | 'DRIVER' | (string & {});

/** Roles that run day-to-day accounts-payable and operations work. */
export const OPERATIONS_ROLES: readonly string[] = ['AP_USER', 'OWNER', 'ADMIN'];

/**
 * Resources a DRIVER session may reach.
 *
 * `drivers-me` is inherently self-scoped. `deliveries` is only safe because
 * `requiresOwnDriverScope` forces the driver filter to come from the verified
 * token subject — see the caller in fetch-cgc-data/index.ts.
 */
export const DRIVER_RESOURCES: readonly string[] = ['drivers-me', 'deliveries'];

export function isOperationsRole(role: SessionRole | null | undefined): boolean {
  return typeof role === 'string' && OPERATIONS_ROLES.includes(role);
}

/**
 * Whether a session holding `role` may read `resource` at all.
 * Unknown or missing roles are denied.
 */
export function canAccessResource(
  role: SessionRole | null | undefined,
  resource: string | null | undefined
): boolean {
  if (!resource) return false;
  if (isOperationsRole(role)) return true;
  if (role !== 'DRIVER') return false;
  return DRIVER_RESOURCES.includes(resource);
}

/**
 * Whether the delivery scope must be derived from the verified token subject
 * rather than any caller-supplied `driverId` query parameter.
 *
 * Operations roles keep their existing ability to filter by an arbitrary
 * driver; every other role is pinned to its own driver profile.
 */
export function requiresOwnDriverScope(
  role: SessionRole | null | undefined,
  resource: string | null | undefined
): boolean {
  return resource === 'deliveries' && !isOperationsRole(role);
}
