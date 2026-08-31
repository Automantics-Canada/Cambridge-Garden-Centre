/**
 * Authorization decisions that need a database lookup.
 *
 * These are separated from the middleware and controllers that call them, and
 * take the data client as a parameter, so the regression suite can exercise
 * every allow/deny branch with a stub instead of a live database. Callers pass
 * the real Prisma client.
 */
import type { UserRole } from '../middleware/authMiddleware.js';

export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
}

interface ActiveUserRecord {
  id: string;
  email: string;
  role: string;
  active: boolean;
}

export interface UserLookupClient {
  user: { findUnique(args: any): Promise<ActiveUserRecord | null> };
}

export interface DeliveryLookupClient {
  delivery: { findFirst(args: any): Promise<{ id: string } | null> };
}

export interface DriverLookupClient {
  driver: { findUnique(args: any): Promise<{ id: string } | null> };
}

/**
 * Re-reads the user named by a verified JWT and returns the session identity,
 * or null when the account no longer exists or has been deactivated.
 *
 * The token's own `role` claim is deliberately discarded: a token issued before
 * a demotion would otherwise keep its old privileges for the rest of its 7-day
 * lifetime.
 */
export async function resolveActiveUser(
  client: UserLookupClient,
  userId: string
): Promise<SessionUser | null> {
  const currentUser = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, active: true },
  });

  if (!currentUser || !currentUser.active) {
    return null;
  }

  return {
    id: currentUser.id,
    email: currentUser.email,
    role: currentUser.role as UserRole,
  };
}

/**
 * Whether `user` may act on `deliveryId`.
 *
 * Operations roles may act on any delivery. A DRIVER may act only on deliveries
 * assigned to the driver profile linked to its own user id, which is what stops
 * one driver from updating another driver's stop or uploading proof against it.
 */
export async function canAccessDelivery(
  client: DeliveryLookupClient,
  user: SessionUser | undefined,
  deliveryId: string
): Promise<boolean> {
  if (!user) return false;
  if (user.role !== 'DRIVER') return true;

  const delivery = await client.delivery.findFirst({
    where: {
      driver: { userId: user.id },
      status: { notIn: ['DELIVERED', 'CANCELLED'] },
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return delivery?.id === deliveryId;
}

/** The driver profile id linked to a user account, or null when there is none. */
export async function findDriverIdForUser(
  client: DriverLookupClient,
  userId: string
): Promise<string | null> {
  const driver = await client.driver.findUnique({
    where: { userId },
    select: { id: true },
  });
  return driver?.id ?? null;
}

/**
 * Resolves which driver's deliveries a caller may read.
 *
 * Operations roles keep the requested id. A DRIVER is pinned to its own profile
 * and is denied outright when it asks for another driver's id, rather than
 * being silently redirected — a silent rewrite would hide a broken client.
 */
export async function resolveDriverDeliveriesScope(
  client: DriverLookupClient,
  user: SessionUser | undefined,
  requestedDriverId: string
): Promise<{ allowed: true; driverId: string } | { allowed: false }> {
  if (!user) return { allowed: false };
  if (user.role !== 'DRIVER') return { allowed: true, driverId: requestedDriverId };

  const ownDriverId = await findDriverIdForUser(client, user.id);
  if (!ownDriverId || ownDriverId !== requestedDriverId) {
    return { allowed: false };
  }
  return { allowed: true, driverId: ownDriverId };
}
