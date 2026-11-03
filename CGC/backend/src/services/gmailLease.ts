import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';

/**
 * One inbox poller at a time, across processes.
 *
 * The API runs the pollers in-process unless `WORKER_MODE=off`, and the
 * worker service always does (workers/runtime.ts), so two processes read the
 * same mailbox every minute; a Railway rollout briefly adds a third. Each
 * created rows under a unique key, so the same attachment could not become two
 * invoices, but the decisions around those rows raced: one poller lost the
 * race on a PDF and then read the Excel beside it as a second invoice, and
 * the two could sort the same page differently. Holding a lease while
 * polling makes the whole poll one process's.
 *
 * The lease is a `SystemSetting` row whose value names the holder and whose
 * `updatedAt` is the last renewal. A poll takes it when it is free, stale
 * (its holder stopped renewing: crashed, or killed by a deploy) or already
 * its own, and renews it while it works. Taking and renewing are single
 * conditional UPDATEs, so two processes cannot both win.
 */

export const POLL_LEASE_KEY = 'gmail.pollLease';

/**
 * A lease not renewed for this long is free. Renewed every minute while a
 * poll runs (one model call can take minutes), so a process that dies holds
 * the inbox for at most this long.
 */
export const POLL_LEASE_MS = 3 * 60 * 1000;
export const POLL_LEASE_RENEW_MS = 60 * 1000;

/** This process, as the lease names it. */
export const LEASE_HOLDER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

type LeaseDb = Pick<typeof prisma, 'systemSetting'>;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Takes the lease for `holder`, or says another process has it. */
export async function acquirePollLease(holder: string, now: Date = new Date(), db: LeaseDb = prisma): Promise<boolean> {
  const value = { holder, since: now.toISOString() };
  const taken = await db.systemSetting.updateMany({
    where: {
      key: POLL_LEASE_KEY,
      OR: [
        { updatedAt: { lt: new Date(now.getTime() - POLL_LEASE_MS) } },
        { value: { path: ['holder'], equals: holder } },
      ],
    },
    data: { value, updatedAt: now },
  });
  if (taken.count === 1) return true;
  try {
    await db.systemSetting.create({ data: { key: POLL_LEASE_KEY, value, updatedAt: now } });
    return true;
  } catch (error) {
    // The row exists and is held by someone else.
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/** Renews the lease; false when `holder` no longer has it. */
export async function renewPollLease(holder: string, now: Date = new Date(), db: LeaseDb = prisma): Promise<boolean> {
  const renewed = await db.systemSetting.updateMany({
    where: { key: POLL_LEASE_KEY, value: { path: ['holder'], equals: holder } },
    data: { updatedAt: now },
  });
  return renewed.count === 1;
}

/** Gives the lease back, so the other process need not wait for it to go stale. */
export async function releasePollLease(holder: string, db: LeaseDb = prisma): Promise<void> {
  await db.systemSetting.updateMany({
    where: { key: POLL_LEASE_KEY, value: { path: ['holder'], equals: holder } },
    data: { updatedAt: new Date(0) },
  });
}
