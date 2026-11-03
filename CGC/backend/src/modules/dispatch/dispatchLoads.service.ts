import type { Prisma } from '@prisma/client';

import { prisma } from '../../db/prisma.js';
import {
  LoadInputError,
  applyLoadInput,
  carriersToRecheck,
  changesRate,
  isUuid,
  loadChanges,
  lockedChanges,
  parseLoadInput,
  type HaulRateUnitValue,
  type LoadChange,
  type LoadState,
} from './dispatchLoadRules.js';
import { haulDateOf, loadHaulTolerances } from '../matching/matching.service.js';
import { withinHaulWindow } from '../matching/haulMatch.js';

/**
 * Dispatch loads: the trucks sent for an order, each with the haul rate the
 * dispatcher agreed (client, Oct 2026, Q14). Office only, like everything
 * else about money: the dispatch router admits AP_USER, OWNER and ADMIN, and
 * nothing here is read through the selects that shape a driver's stop.
 *
 * Every write leaves an audit row on the order: LOAD_CREATED, LOAD_UPDATED,
 * LOAD_RATE_SET when the rate or its unit changed, LOAD_DELETED.
 */

export class DispatchLoadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The load as the office reads it, with the names the board shows. */
const LOAD_SELECT = {
  id: true,
  documentId: true,
  deliveryId: true,
  sequence: true,
  carrierSupplierId: true,
  driverId: true,
  rate: true,
  rateUnit: true,
  quantity: true,
  sourceSupplierId: true,
  tripRef: true,
  ticketNumber: true,
  notes: true,
  claimedByLineItemId: true,
  claimedAt: true,
  createdAt: true,
  updatedAt: true,
  carrierSupplier: { select: { name: true } },
  sourceSupplier: { select: { name: true } },
  driver: { select: { name: true, type: true, companyName: true } },
  setBy: { select: { name: true } },
  // The haul day, as the matcher dates a load (haulDateOf), to scope its trip.
  document: { select: { documentNumber: true, deliveryDate: true } },
  delivery: { select: { completedAt: true } },
} satisfies Prisma.DispatchLoadSelect;

type LoadRow = Prisma.DispatchLoadGetPayload<{ select: typeof LOAD_SELECT }>;

/** The other loads of a trip, as a load's `trip` summary counts them. */
export interface TripSummary {
  /** How many loads are on the trip, this one included. */
  loads: number;
  /** The orders the trip serves, by Spruce number. */
  orders: string[];
  /** Every load of the trip carries the same rate and unit. */
  sameRate: boolean;
}

/** One load, for office screens only. Never part of a driver's payload. */
export interface DispatchLoadView {
  id: string;
  documentId: string;
  deliveryId: string | null;
  sequence: number;
  /** Null: CGC's own fleet. */
  carrierSupplierId: string | null;
  carrierName: string | null;
  driverId: string | null;
  driverName: string | null;
  driverType: 'CGC_FLEET' | 'INDEPENDENT' | null;
  rate: number | null;
  rateUnit: HaulRateUnitValue | null;
  quantity: number | null;
  sourceSupplierId: string | null;
  sourceName: string | null;
  tripRef: string | null;
  ticketNumber: string | null;
  notes: string | null;
  /** Paid by a trucking invoice line: only the note can change now. */
  claimed: boolean;
  claimedAt: Date | null;
  setByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  trip: TripSummary | null;
}

const numberOrNull = (value: Prisma.Decimal | null) => (value === null ? null : Number(value));

function toView(row: LoadRow, trips: Map<string, TripSummary>): DispatchLoadView {
  return {
    id: row.id,
    documentId: row.documentId,
    deliveryId: row.deliveryId,
    sequence: row.sequence,
    carrierSupplierId: row.carrierSupplierId,
    carrierName: row.carrierSupplier?.name ?? null,
    driverId: row.driverId,
    driverName: row.driver ? (row.driver.companyName ? `${row.driver.name} (${row.driver.companyName})` : row.driver.name) : null,
    driverType: row.driver?.type ?? null,
    rate: numberOrNull(row.rate),
    rateUnit: row.rateUnit,
    quantity: numberOrNull(row.quantity),
    sourceSupplierId: row.sourceSupplierId,
    sourceName: row.sourceSupplier?.name ?? null,
    tripRef: row.tripRef,
    ticketNumber: row.ticketNumber,
    notes: row.notes,
    claimed: row.claimedByLineItemId !== null,
    // The paying line can be deleted (the key clears, the date does not).
    claimedAt: row.claimedByLineItemId !== null ? row.claimedAt : null,
    setByName: row.setBy?.name ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    trip: row.tripRef ? trips.get(row.id) ?? null : null,
  };
}

/** What deciding which loads are one trip needs of a load. */
const TRIP_LOAD_SELECT = {
  id: true,
  tripRef: true,
  carrierSupplierId: true,
  rate: true,
  rateUnit: true,
  claimedByLineItemId: true,
  documentId: true,
  sequence: true,
  createdAt: true,
  document: { select: { documentNumber: true, deliveryDate: true, flags: true } },
  delivery: { select: { completedAt: true } },
} satisfies Prisma.DispatchLoadSelect;

type TripLoadRow = Prisma.DispatchLoadGetPayload<{ select: typeof TRIP_LOAD_SELECT }>;

/**
 * Whether `load` is on the same trip as a load hauled on `haulDate`: hauled
 * within the matcher's date window of it (haulMatch.ts).
 *
 * A trip reference is short free text, and dispatch reuses it. The matcher
 * already treats the same reference weeks apart as another trip; without the
 * same limit here the board summed last month's T-1 into today's, refused
 * today's T-1 to another carrier for good, and "Use this rate for the whole
 * trip" repriced an unpaid load from last month, so its invoice was checked
 * against the wrong rate.
 */
const nearHaulDay = (load: Parameters<typeof haulDateOf>[0], haulDate: Date, windowDays: number) =>
  withinHaulWindow(haulDateOf(load), haulDate, windowDays);

/** The loads with this trip reference (and `where`) on the same trip as a load hauled on `haulDate`. */
async function tripLoadsNear(
  db: Pick<Prisma.TransactionClient, 'dispatchLoad' | 'systemSetting'>,
  tripRef: string,
  haulDate: Date,
  where: Prisma.DispatchLoadWhereInput = {}
): Promise<TripLoadRow[]> {
  const { haulDateWindowDays } = await loadHaulTolerances(db);
  const loads = await db.dispatchLoad.findMany({
    where: { ...where, tripRef },
    select: TRIP_LOAD_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  return loads.filter(load => nearHaulDay(load, haulDate, haulDateWindowDays));
}

/**
 * Each trip load's summary, by load id: the loads of its trip (same
 * reference, same carrier, within the haul window of this load). One read
 * for the whole board.
 */
async function tripSummaries(db: Pick<Prisma.TransactionClient, 'dispatchLoad' | 'systemSetting'>, rows: LoadRow[]) {
  const result = new Map<string, TripSummary>();
  const refs = [...new Set(rows.flatMap(row => (row.tripRef ? [row.tripRef] : [])))];
  if (refs.length === 0) return result;
  // One after the other: `db` may be a transaction, which runs one query at a time.
  const { haulDateWindowDays } = await loadHaulTolerances(db);
  const loads = await db.dispatchLoad.findMany({
    where: { tripRef: { in: refs } },
    select: TRIP_LOAD_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  for (const row of rows) {
    if (!row.tripRef) continue;
    const haulDate = haulDateOf(row);
    const trip = loads.filter(
      load =>
        load.tripRef === row.tripRef &&
        load.carrierSupplierId === row.carrierSupplierId &&
        nearHaulDay(load, haulDate, haulDateWindowDays)
    );
    result.set(row.id, {
      loads: trip.length,
      orders: [...new Set(trip.map(load => load.document.documentNumber))],
      sameRate: new Set(trip.map(load => `${load.rate === null ? 'none' : Number(load.rate)}|${load.rateUnit}`)).size <= 1,
    });
  }
  return result;
}

async function viewsOf(db: Pick<Prisma.TransactionClient, 'dispatchLoad' | 'systemSetting'>, rows: LoadRow[]) {
  const trips = await tripSummaries(db, rows);
  return rows.map(row => toView(row, trips));
}

/**
 * Every load of each order, by order id, in load order. One read for the whole
 * board; office screens only.
 */
export async function haulLoadsByDocument(
  db: Pick<Prisma.TransactionClient, 'dispatchLoad' | 'systemSetting'>,
  documentIds: string[]
): Promise<Map<string, DispatchLoadView[]>> {
  const ids = [...new Set(documentIds)];
  const result = new Map<string, DispatchLoadView[]>(ids.map(id => [id, []]));
  if (ids.length === 0) return result;
  const rows = await db.dispatchLoad.findMany({
    where: { documentId: { in: ids } },
    select: LOAD_SELECT,
    orderBy: [{ documentId: 'asc' }, { sequence: 'asc' }],
  });
  for (const view of await viewsOf(db, rows)) result.get(view.documentId)!.push(view);
  return result;
}

const stateOf = (row: {
  carrierSupplierId: string | null; driverId: string | null; rate: Prisma.Decimal | null;
  rateUnit: HaulRateUnitValue | null; quantity: Prisma.Decimal | null; sourceSupplierId: string | null;
  tripRef: string | null; ticketNumber: string | null; notes: string | null;
}): LoadState => ({
  carrierSupplierId: row.carrierSupplierId,
  driverId: row.driverId,
  rate: row.rate === null ? null : row.rate.toString(),
  rateUnit: row.rateUnit,
  quantity: row.quantity === null ? null : row.quantity.toString(),
  sourceSupplierId: row.sourceSupplierId,
  tripRef: row.tripRef,
  ticketNumber: row.ticketNumber,
  notes: row.notes,
});

const EMPTY_STATE: LoadState = {
  carrierSupplierId: null, driverId: null, rate: null, rateUnit: null, quantity: null,
  sourceSupplierId: null, tripRef: null, ticketNumber: null, notes: null,
};

type OrderForLoads = {
  id: string;
  documentNumber: string;
  flags: string[];
  pickupSupplierId: string | null;
  deliveryDate: Date | null;
  delivery: { id: string; completedAt: Date | null; driver: { id: string; type: string } | null } | null;
};

async function orderFor(tx: Prisma.TransactionClient, documentId: string): Promise<OrderForLoads> {
  const order = isUuid(documentId)
    ? await tx.orderDocument.findUnique({
        where: { id: documentId },
        select: {
          id: true, documentNumber: true, flags: true, pickupSupplierId: true, deliveryDate: true,
          delivery: { select: { id: true, completedAt: true, driver: { select: { id: true, type: true } } } },
        },
      })
    : null;
  if (!order) throw new DispatchLoadError(404, 'That order no longer exists.');
  return order;
}

/** A quotation is a price given to a customer, not an order: nothing is hauled for it. */
function refuseQuotation(order: { documentNumber: string; flags: string[] }) {
  if (order.flags.includes('QUOTE')) {
    throw new DispatchLoadError(409, `${order.documentNumber} is a quotation in Spruce, not an order, so it has no loads.`);
  }
}

/**
 * The carrier, driver, pit and trip a load names are real and fit together:
 * a carrier is an active trucking company, and one trip has one carrier.
 * A trip is the loads with its reference hauled within the matcher's date
 * window of this load (`haulDate`); the reference used again later is free.
 */
async function checkReferences(
  tx: Prisma.TransactionClient,
  state: LoadState,
  changes: LoadChange[],
  loadId: string | null,
  haulDate: Date
) {
  const changed = (field: keyof LoadState) => changes.some(change => change.field === field);

  if (state.carrierSupplierId && changed('carrierSupplierId')) {
    const carrier = await tx.supplier.findUnique({
      where: { id: state.carrierSupplierId },
      select: { type: true, active: true, name: true },
    });
    if (!carrier?.active) throw new DispatchLoadError(400, 'That carrier is not an active supplier.');
    if (carrier.type !== 'TRUCKING_COMPANY') {
      throw new DispatchLoadError(
        400,
        `${carrier.name} is not a trucking company. Pick a trucking company, or CGC fleet for our own trucks.`
      );
    }
  }
  if (state.sourceSupplierId && changed('sourceSupplierId')) {
    const source = await tx.supplier.findUnique({ where: { id: state.sourceSupplierId }, select: { active: true } });
    if (!source?.active) throw new DispatchLoadError(400, 'That pit or supplier is not an active supplier.');
  }
  if (state.driverId && changed('driverId')) {
    const driver = await tx.driver.findUnique({ where: { id: state.driverId }, select: { id: true } });
    if (!driver) throw new DispatchLoadError(400, 'That driver no longer exists.');
  }
  if (state.tripRef && (changed('tripRef') || changed('carrierSupplierId'))) {
    // Another load of the trip with a different carrier. CGC's own trucks
    // (no carrier) count as a carrier of their own here.
    const [other] = await tripLoadsNear(tx, state.tripRef, haulDate, {
      ...(loadId ? { id: { not: loadId } } : {}),
      ...(state.carrierSupplierId === null
        ? { carrierSupplierId: { not: null } }
        : { OR: [{ carrierSupplierId: null }, { carrierSupplierId: { not: state.carrierSupplierId } }] }),
    });
    if (other) {
      const carrier = other.carrierSupplierId
        ? (await tx.supplier.findUnique({ where: { id: other.carrierSupplierId }, select: { name: true } }))?.name ?? 'another carrier'
        : 'CGC fleet';
      throw new DispatchLoadError(
        409,
        `Trip ${state.tripRef} is with ${carrier}. ` +
          'A trip has one carrier: change this load\'s carrier or use another trip reference.'
      );
    }
  }
}

function auditData(
  action: 'LOAD_CREATED' | 'LOAD_UPDATED' | 'LOAD_RATE_SET' | 'LOAD_DELETED',
  load: { id: string; documentId: string; sequence: number },
  documentNumber: string,
  userId: string,
  changes: LoadChange[],
  extra: Record<string, unknown> = {}
): Prisma.AuditLogUncheckedCreateInput {
  return {
    entityType: 'ORDER',
    entityId: load.documentId,
    actionType: action,
    performedById: userId,
    details: {
      documentNumber,
      loadId: load.id,
      sequence: load.sequence,
      changes,
      ...extra,
    } as unknown as Prisma.InputJsonValue,
  };
}

const dataOf = (state: LoadState) => ({
  carrierSupplierId: state.carrierSupplierId,
  driverId: state.driverId,
  rate: state.rate,
  rateUnit: state.rateUnit,
  quantity: state.quantity,
  sourceSupplierId: state.sourceSupplierId,
  tripRef: state.tripRef,
  ticketNumber: state.ticketNumber,
  notes: state.notes,
});

/** A load by id, with its order, or a 404. */
async function loadFor(tx: Prisma.TransactionClient, loadId: string) {
  const load = isUuid(loadId)
    ? await tx.dispatchLoad.findUnique({
        where: { id: loadId },
        select: {
          id: true, documentId: true, sequence: true, deliveryId: true, claimedByLineItemId: true,
          carrierSupplierId: true, driverId: true, rate: true, rateUnit: true, quantity: true,
          sourceSupplierId: true, tripRef: true, ticketNumber: true, notes: true, createdAt: true,
          delivery: { select: { completedAt: true } },
          document: { select: { documentNumber: true, flags: true, deliveryDate: true, delivery: { select: { id: true } } } },
        },
      })
    : null;
  if (!load) throw new DispatchLoadError(404, 'That load no longer exists. Refresh the board.');
  return load;
}

/**
 * When an order's stop moves to another truck, the loads that went with the
 * old truck go with the new one: a brokered (INDEPENDENT) driver is named on
 * them, any other driver leaves them unnamed. Without this a load keeps the
 * first brokered driver for good (the board's form has no driver field), and
 * the "No haul rate" badge and the matcher would still read that driver after
 * dispatch moved the order to a CGC truck.
 *
 * Only loads that named the stop's old driver, or no driver, move; a driver
 * set on purpose to someone else stays. A paid load keeps its figures.
 */
export async function loadsFollowStopDriver(
  tx: Pick<Prisma.TransactionClient, 'dispatchLoad'>,
  documentId: string,
  fromDriverId: string | null,
  to: { id: string; type: string } | null
) {
  const toDriverId = to?.type === 'INDEPENDENT' ? to.id : null;
  // Moving to no brokered driver only clears the old one's name.
  const named = toDriverId
    ? [{ driverId: null }, ...(fromDriverId ? [{ driverId: fromDriverId }] : [])]
    : fromDriverId ? [{ driverId: fromDriverId }] : [];
  if (named.length === 0) return;
  await tx.dispatchLoad.updateMany({
    where: { documentId, claimedByLineItemId: null, OR: named },
    data: { driverId: toDriverId },
  });
}

/**
 * Re-decides the open invoice lines of these trucking companies, after the
 * load change is saved. Best-effort, like the re-check after a haul is paid
 * (resolveMatch.ts): the dispatcher's change stands whatever happens here,
 * and a failure is logged, never sent back to the board.
 */
async function recheckCarrierLines(carrierIds: string[], context: string): Promise<void> {
  if (carrierIds.length === 0) return;
  try {
    const { recomputeCarrierLinesSafely } = await import('../matching/resolveMatch.js');
    for (const carrierId of carrierIds) await recomputeCarrierLinesSafely(carrierId, context);
  } catch (error) {
    console.error(`[DispatchLoads] ${context}: could not re-check the carrier's invoices:`, error);
  }
}

const CLAIMED_MESSAGE = 'This load is already paid on a trucking invoice, so its figures are locked. Only the note can change.';

export const DispatchLoadsService = {
  /** The order's loads, in order, with the order's pit as the default for a new one. */
  async list(documentId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await orderFor(tx, documentId);
      const rows = await tx.dispatchLoad.findMany({
        where: { documentId: order.id },
        select: LOAD_SELECT,
        orderBy: { sequence: 'asc' },
      });
      return {
        documentId: order.id,
        documentNumber: order.documentNumber,
        quote: order.flags.includes('QUOTE'),
        pickupSupplierId: order.pickupSupplierId,
        stopDriverType: order.delivery?.driver?.type ?? null,
        loads: await viewsOf(tx, rows),
      };
    });
  },

  /**
   * Records a new load on an order. It takes the next number, the order's stop,
   * the order's pit unless one is named, and the stop's driver when that is an
   * independent (brokered) one, unless the request names a driver.
   */
  async create(documentId: string, body: unknown, userId: string): Promise<DispatchLoadView> {
    const input = parseLoadInput(body);
    return prisma.$transaction(async (tx) => {
      const order = await orderFor(tx, documentId);
      refuseQuotation(order);

      const defaults: LoadState = {
        ...EMPTY_STATE,
        sourceSupplierId: order.pickupSupplierId,
        driverId: order.delivery?.driver?.type === 'INDEPENDENT' ? order.delivery.driver.id : null,
      };
      const state = applyLoadInput(defaults, input);
      const changes = loadChanges(EMPTY_STATE, state);
      // The day the matcher will date this load: it is filed under the stop.
      const haulDate = haulDateOf({ document: order, delivery: order.delivery, createdAt: new Date() });
      await checkReferences(tx, state, changes, null, haulDate);

      const last = await tx.dispatchLoad.findFirst({
        where: { documentId: order.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const created = await tx.dispatchLoad.create({
        data: {
          ...dataOf(state),
          documentId: order.id,
          deliveryId: order.delivery?.id ?? null,
          sequence: (last?.sequence ?? 0) + 1,
          setById: userId,
        },
        select: LOAD_SELECT,
      });
      await tx.auditLog.create({ data: auditData('LOAD_CREATED', created, order.documentNumber, userId, changes) });
      return (await viewsOf(tx, [created]))[0]!;
    });
  },

  /** Changes a load. A paid load keeps everything but its note (409). */
  async update(loadId: string, body: unknown, userId: string): Promise<DispatchLoadView> {
    const input = parseLoadInput(body);
    let recheck: string[] = [];
    const view = await prisma.$transaction(async (tx) => {
      const load = await loadFor(tx, loadId);
      refuseQuotation(load.document);

      const before = stateOf(load);
      const after = applyLoadInput(before, input);
      const changes = loadChanges(before, after);
      if (load.claimedByLineItemId && lockedChanges(changes).length > 0) {
        throw new DispatchLoadError(409, CLAIMED_MESSAGE);
      }
      await checkReferences(tx, after, changes, load.id, haulDateOf(load));

      if (changes.length > 0) {
        // Re-checked in the write, so a claim made since the read is not overwritten.
        const written = await tx.dispatchLoad.updateMany({
          where: {
            id: load.id,
            ...(lockedChanges(changes).length > 0 ? { claimedByLineItemId: null } : {}),
          },
          data: {
            ...dataOf(after),
            // A load made before the order had a stop is filed under it now.
            deliveryId: load.deliveryId ?? load.document.delivery?.id ?? null,
            setById: userId,
          },
        });
        if (written.count === 0) throw new DispatchLoadError(409, CLAIMED_MESSAGE);
        await tx.auditLog.create({
          data: auditData(changesRate(changes) ? 'LOAD_RATE_SET' : 'LOAD_UPDATED', load, load.document.documentNumber, userId, changes),
        });
        recheck = carriersToRecheck(before, after, changes);
      }
      const row = await tx.dispatchLoad.findUniqueOrThrow({ where: { id: load.id }, select: LOAD_SELECT });
      return (await viewsOf(tx, [row]))[0]!;
    });
    // An invoice waiting on this load ("No haul rate set", a ticket nobody
    // had written down) is decided again now the load says more.
    await recheckCarrierLines(recheck, `load ${view.id} changed`);
    return view;
  },

  /**
   * Removes a load. A paid one stays (409): its invoice line points at it.
   * A load on an order flagged a quotation since can still be removed, so a
   * stray one does not linger.
   */
  async remove(loadId: string, userId: string) {
    let recheck: string[] = [];
    const removedLoad = await prisma.$transaction(async (tx) => {
      const load = await loadFor(tx, loadId);
      if (load.claimedByLineItemId) {
        throw new DispatchLoadError(409, 'This load is already paid on a trucking invoice, so it cannot be removed.');
      }
      const removed = await tx.dispatchLoad.deleteMany({ where: { id: load.id, claimedByLineItemId: null } });
      if (removed.count === 0) {
        throw new DispatchLoadError(409, 'This load is already paid on a trucking invoice, so it cannot be removed.');
      }
      const changes = loadChanges(stateOf(load), EMPTY_STATE);
      await tx.auditLog.create({
        data: auditData('LOAD_DELETED', load, load.document.documentNumber, userId, changes),
      });
      recheck = carriersToRecheck(stateOf(load), null, changes);
      return { id: load.id, deleted: true };
    });
    // A line that was matched to this load no longer can be.
    await recheckCarrierLines(recheck, `load ${removedLoad.id} removed`);
    return removedLoad;
  },

  /**
   * Gives every other load of this load's trip the same rate and unit: the
   * loads one brokered truck collected together (A4) are priced alike,
   * whether the carrier bills the trip on one line or load by load. The trip
   * is this carrier's loads with the reference within the haul window of this
   * load, as the matcher reads it; the same reference used weeks apart is
   * another trip and keeps its own rate. Loads already paid, and
   * loads on an order that is now a quotation, are left as they are and
   * counted as skipped.
   */
  async copyRateToTrip(loadId: string, userId: string) {
    let carrierId: string | null = null;
    const outcome = await prisma.$transaction(async (tx) => {
      const source = await loadFor(tx, loadId);
      refuseQuotation(source.document);
      if (!source.tripRef) throw new DispatchLoadError(400, 'This load is not on a trip. Give it a trip reference first.');
      if (source.rate === null) throw new DispatchLoadError(400, 'This load has no rate to copy yet.');

      // The same trip only: this carrier's loads with the reference near this
      // load's haul day. A reference reused weeks later is another trip.
      const others = await tripLoadsNear(tx, source.tripRef, haulDateOf(source), {
        id: { not: source.id },
        carrierSupplierId: source.carrierSupplierId,
      });

      let updated = 0;
      let skipped = 0;
      for (const other of others) {
        const same = other.rate !== null && Number(other.rate) === Number(source.rate) && other.rateUnit === source.rateUnit;
        if (same) continue;
        if (other.claimedByLineItemId || other.document.flags.includes('QUOTE')) {
          skipped += 1;
          continue;
        }
        const written = await tx.dispatchLoad.updateMany({
          where: { id: other.id, claimedByLineItemId: null },
          data: { rate: source.rate, rateUnit: source.rateUnit, setById: userId },
        });
        if (written.count === 0) {
          skipped += 1;
          continue;
        }
        updated += 1;
        const changes: LoadChange[] = [
          { field: 'rate', from: other.rate?.toString() ?? null, to: source.rate.toString() },
          { field: 'rateUnit', from: other.rateUnit, to: source.rateUnit },
        ].filter(change => change.from !== change.to) as LoadChange[];
        await tx.auditLog.create({
          data: auditData('LOAD_RATE_SET', other, other.document.documentNumber, userId, changes, {
            copiedFromLoadId: source.id,
            tripRef: source.tripRef,
          }),
        });
      }
      // One trip has one carrier (checkReferences), so the source's is the trip's.
      if (updated > 0) carrierId = source.carrierSupplierId;
      return { tripRef: source.tripRef, updated, skipped };
    });
    await recheckCarrierLines(carrierId ? [carrierId] : [], `trip ${outcome.tripRef} rate copied`);
    return outcome;
  },
};

export { LoadInputError };
