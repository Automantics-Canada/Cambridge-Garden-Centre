import type { DeliveryStatus, Prisma } from '@prisma/client';

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
 * Orders from before today that never went out: no stop, or a stop taken back
 * off its driver and not finished.
 *
 * Orders still on a driver's run are left out on purpose. The board already
 * shows every driver's open work under that driver, so listing them here as
 * well would put one order on screen twice.
 *
 * Orders Spruce no longer lists as open are left out too: nobody will deliver
 * them, and nothing else would ever take them off this list.
 */
export function carriedOverWhere(today: string): Prisma.OrderDocumentWhereInput {
  return {
    deliveryDate: { lt: deliveryDayDate(today) },
    isPickup: false,
    NOT: CLOSED_IN_SPRUCE,
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
