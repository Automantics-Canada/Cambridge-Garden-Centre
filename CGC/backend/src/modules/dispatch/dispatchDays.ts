import type { DeliveryStatus, Prisma } from '@prisma/client';

import { businessDayRange } from '../../lib/businessDay.js';

/**
 * Which orders belong to which part of the board, by date.
 *
 * Every day here is a 'YYYY-MM-DD' calendar date in the yard's timezone, and
 * delivery dates are stored as calendar dates without a time, so the two are
 * compared as dates at midnight UTC — never as instants.
 */

/** A stop in either of these states is history, and is never reassigned. */
export const FINISHED_STATUSES: DeliveryStatus[] = ['DELIVERED', 'CANCELLED'];

/** A 'YYYY-MM-DD' day as the stored delivery date it compares against. */
export const deliveryDayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** The 'YYYY-MM-DD' of a stored delivery date. */
export const dayOfDeliveryDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Yesterday and older are read-only. ISO dates sort as strings, so this needs
 * no parsing.
 */
export const isPastDay = (day: string, today: string) => day < today;

/**
 * Orders Spruce no longer lists as open: invoiced, closed or voided since.
 * They are waiting for nothing, so Carried over and Pickups leave them out.
 */
const CLOSED_IN_SPRUCE: Prisma.OrderDocumentWhereInput = { flags: { has: 'NOT_OPEN' } };

/**
 * Orders an upload described on `day`: first imported that day, or described
 * again by that day's reports, since a re-upload updates an order and keeps
 * its `createdAt`. The Orders page's Upload date filter counts the same way,
 * so both screens agree on what "uploaded today" holds.
 *
 * @param day 'YYYY-MM-DD' in the yard's timezone
 */
export function uploadedOnWhere(day: string): Prisma.OrderDocumentWhereInput {
  const range = businessDayRange(day);
  if (!range) throw Object.assign(new Error(`Invalid date: ${day}`), { status: 400 });
  return { OR: [{ createdAt: range }, { lastBatch: { is: { createdAt: range } } }] };
}

/** Never dispatched, or dispatched and taken back. */
const WITHOUT_DRIVER: Prisma.OrderDocumentWhereInput = {
  OR: [{ delivery: null }, { delivery: { driverId: null } }],
};

/**
 * Today's pool: every delivery due out today, and every delivery in today's
 * uploads, that no driver has yet.
 *
 * The morning's upload is the day's work. An order in it goes on the board
 * whatever date Spruce gave it — none yet, a later day, or a day already
 * gone — so a dispatcher who has just uploaded sees what came in without
 * hunting through the other tabs. A later order still counts on its own day
 * under Upcoming; tomorrow it is no longer today's upload, and goes back to
 * being found by its date.
 *
 * Orders Spruce no longer lists as open are left out of the uploads: nobody
 * will deliver them. Pickups never wait for a driver.
 */
export function todayPoolWhere(today: string): Prisma.OrderDocumentWhereInput {
  return {
    isPickup: false,
    AND: [
      WITHOUT_DRIVER,
      {
        OR: [
          { deliveryDate: deliveryDayDate(today) },
          { AND: [uploadedOnWhere(today), { NOT: CLOSED_IN_SPRUCE }] },
        ],
      },
    ],
  };
}

/**
 * Orders from before today that never went out: no stop, or a stop taken back
 * off its driver and not finished.
 *
 * Orders still on a driver's run are left out on purpose. The board already
 * shows every driver's open work under that driver, so listing them here as
 * well would put one order on screen twice. Orders in today's uploads are
 * left out for the same reason: they are in today's pool.
 *
 * Orders Spruce no longer lists as open are left out too: nobody will deliver
 * them, and nothing else would ever take them off this list.
 */
export function carriedOverWhere(today: string): Prisma.OrderDocumentWhereInput {
  return {
    deliveryDate: { lt: deliveryDayDate(today) },
    isPickup: false,
    NOT: [CLOSED_IN_SPRUCE, uploadedOnWhere(today)],
    OR: [
      { delivery: null },
      { delivery: { driverId: null, status: { notIn: FINISHED_STATUSES } } },
    ],
  };
}

/** Orders due out after today. Pickups have no date, so never count. */
export function upcomingWhere(today: string): Prisma.OrderDocumentWhereInput {
  return { deliveryDate: { gt: deliveryDayDate(today) }, isPickup: false };
}

/**
 * Orders with no delivery date: pickups, and deliveries Spruce has not given a
 * date yet. The import only ever marks an undated order as a pickup, and an
 * undated order with a delivery charge is not one — so listing pickups alone
 * would leave those deliveries on no screen at all.
 *
 * An order Spruce no longer lists as open, pickup or not, has been invoiced,
 * closed or voided; it is waiting for nothing, so it is left out.
 */
const UNDATED: Prisma.OrderDocumentWhereInput = {
  NOT: CLOSED_IN_SPRUCE,
  OR: [{ isPickup: true }, { deliveryDate: null }],
};

export function undatedWhere(search?: string): Prisma.OrderDocumentWhereInput {
  const where = UNDATED;
  const term = search?.trim();
  if (!term) return where;
  return {
    AND: [
      where,
      {
        OR: [
          { documentNumber: { contains: term, mode: 'insensitive' } },
          { customerName: { contains: term, mode: 'insensitive' } },
        ],
      },
    ],
  };
}

export interface UpcomingDay {
  /** 'YYYY-MM-DD'. */
  date: string;
  /** Orders due out that day. */
  count: number;
  /** Of those, the ones no driver has yet. */
  unassigned: number;
}

type DayCount = { deliveryDate: Date | null; _count: { _all: number } };

/** One entry per future day, soonest first, from two grouped counts. */
export function upcomingDays(all: DayCount[], unassigned: DayCount[]): UpcomingDay[] {
  const waiting = new Map<string, number>();
  for (const row of unassigned) {
    if (row.deliveryDate) waiting.set(dayOfDeliveryDate(row.deliveryDate), row._count._all);
  }
  return all
    .filter((row): row is DayCount & { deliveryDate: Date } => row.deliveryDate !== null)
    .map(row => {
      const date = dayOfDeliveryDate(row.deliveryDate);
      return { date, count: row._count._all, unassigned: waiting.get(date) ?? 0 };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
