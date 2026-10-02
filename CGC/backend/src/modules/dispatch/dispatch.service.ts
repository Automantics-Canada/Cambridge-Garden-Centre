import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import { MailService } from '../../services/mail.service.js';
import { businessDayOf, businessDayRange } from '../../lib/businessDay.js';
import { DISPATCH_DOCUMENT_SELECT, representativeLineId, toDispatchOrder } from './dispatchOrderView.js';
import {
  FINISHED_STATUSES as FINISHED,
  carriedOverWhere,
  deliveryDayDate,
  isPastDay,
  undatedWhere,
  upcomingDays,
  upcomingWhere,
} from './dispatchDays.js';

/** Enough to find an order by number or name; more is a narrower search. */
const UNDATED_LIMIT = 100;

function dispatchError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/**
 * The line fields the board renders for a stop made before orders were
 * dispatched whole, and nothing else.
 */
export const DISPATCH_ORDER_SELECT = {
  id: true,
  spruceOrderId: true,
  customerName: true,
  product: true,
  quantity: true,
  unit: true,
  createdAt: true,
} as const;

export const DispatchService = {
  /**
   * The board for one day: that day's orders still waiting for a driver, and
   * every driver's run.
   *
   * The pool is the orders due out that day — their delivery date, in the
   * yard's calendar — not the rows uploaded that day. Filtering on upload time
   * showed an order the morning it was imported and lost it the next, even when
   * it was due next week. Pickups are collected from the yard and never wait
   * for a driver.
   *
   * Yesterday and older are history: `readOnly`, and each driver's run shows
   * only what was due or finished that day, not the work open now. Today also
   * lists `carriedOver`, the earlier orders that never went out.
   *
   * @param day 'YYYY-MM-DD' in the yard's timezone. Defaults to today there.
   * @param today Today there; for tests.
   */
  async getDispatchBoard(day?: string, today: string = businessDayOf()) {
    const requestedDay = day || today;
    const dayRange = businessDayRange(requestedDay);
    if (!dayRange) {
      throw Object.assign(new Error(`Invalid date: ${requestedDay}`), { status: 400 });
    }
    // Delivery dates are calendar dates, stored without a time.
    const deliveryDay = deliveryDayDate(requestedDay);
    const readOnly = isPastDay(requestedDay, today);

    const carriedOver = requestedDay === today
      ? await prisma.orderDocument.findMany({
          where: carriedOverWhere(today),
          select: DISPATCH_DOCUMENT_SELECT,
          orderBy: [{ deliveryDate: 'asc' }, { documentNumber: 'asc' }],
        })
      : [];

    const waiting = await prisma.orderDocument.findMany({
      where: {
        deliveryDate: deliveryDay,
        isPickup: false,
        // Never dispatched, or dispatched and taken back.
        OR: [{ delivery: null }, { delivery: { driverId: null } }],
      },
      select: DISPATCH_DOCUMENT_SELECT,
      orderBy: { documentNumber: 'asc' },
    });

    const drivers = await prisma.driver.findMany({
      where: { active: true },
      include: {
        deliveries: {
          orderBy: { priority: 'asc' },
          where: {
            OR: [
              // Open work always shows on today and later: a stop raised on
              // Monday and still not delivered is live whichever of those days
              // is being viewed. A past day is a record of that day instead,
              // so it shows the stops that were due out on it; the work open
              // now belongs to today's board, where it can still be changed.
              readOnly
                ? { document: { deliveryDate: deliveryDay } }
                : { status: { notIn: FINISHED } },
              // Completed work shows for the day being viewed, so the whole
              // board describes one day rather than mixing the pool's date with
              // today's completions.
              { completedAt: { gte: dayRange.gte, lte: dayRange.lte } }
            ]
          },
          include: {
            document: { select: DISPATCH_DOCUMENT_SELECT },
            // Stops made before orders were dispatched whole have only a line,
            // read through the same bounded projection as ever.
            order: { select: DISPATCH_ORDER_SELECT },
            history: {
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      }
    });

    return {
      day: requestedDay,
      readOnly,
      carriedOver: carriedOver.map(toDispatchOrder),
      unassignedOrders: waiting.map(toDispatchOrder),
      // Kept for the screen's merge; whole orders come back to the pool above.
      unassignedDeliveries: [],
      drivers: drivers.map(d => {
        const deliveries = d.deliveries.map(({ document, order, ...delivery }) => ({
          ...delivery,
          order: document ? toDispatchOrder(document) : { ...order, wholeOrder: false as const },
        }));
        return {
          ...d,
          deliveries,
          todayDeliveries: deliveries.length,
          completedToday: deliveries.filter(del => del.status === 'DELIVERED').length
        };
      })
    };
  },

  /**
   * Each day after today with orders due out, how many, and how many still
   * need a driver — so a dispatcher can open that day and assign ahead.
   *
   * @param today 'YYYY-MM-DD' in the yard's timezone; for tests.
   */
  async getUpcoming(today: string = businessDayOf()) {
    const where = upcomingWhere(today);
    const [all, unassigned] = await Promise.all([
      prisma.orderDocument.groupBy({ by: ['deliveryDate'], where, _count: { _all: true } }),
      prisma.orderDocument.groupBy({
        by: ['deliveryDate'],
        where: { ...where, OR: [{ delivery: null }, { delivery: { driverId: null } }] },
        _count: { _all: true },
      }),
    ]);
    return upcomingDays(all, unassigned);
  },

  /**
   * Orders with no delivery date — pickups, and deliveries still waiting for
   * Spruce to give them one. They are never on a day's board, so this is the
   * only place to find them. Newest order numbers first.
   */
  async getUndatedOrders(search?: string) {
    const documents = await prisma.orderDocument.findMany({
      where: undatedWhere(search),
      select: { ...DISPATCH_DOCUMENT_SELECT, isPickup: true },
      orderBy: { documentNumber: 'desc' },
      take: UNDATED_LIMIT,
    });
    return documents.map(({ isPickup, ...document }) => ({ ...toDispatchOrder(document), isPickup }));
  },

  /**
   * Gives a whole order to a driver, or moves it to another.
   *
   * The stop joins the end of the driver's run. Every line of the order is
   * marked with the driver too: the re-import treats a line with a driver as
   * one it must not re-pair by guesswork, and that safety net was built on
   * lines.
   */
  async assignOrder(documentId: string, driverId: string) {
    return prisma.$transaction(async (tx) => {
      const document = await tx.orderDocument.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          documentNumber: true,
          lines: DISPATCH_DOCUMENT_SELECT.lines,
          delivery: { select: { id: true, status: true } },
        },
      });
      if (!document) throw dispatchError(404, 'That order no longer exists.');
      if (document.delivery && FINISHED.includes(document.delivery.status)) {
        throw dispatchError(409, `${document.documentNumber} is already ${document.delivery.status.toLowerCase()}.`);
      }

      const lineId = representativeLineId(document);
      if (!lineId) throw dispatchError(409, `${document.documentNumber} has no lines to deliver.`);

      const driver = await tx.driver.findUnique({ where: { id: driverId }, select: { active: true } });
      if (!driver?.active) throw dispatchError(404, 'That driver is not active.');

      const last = await tx.delivery.findFirst({
        where: {
          driverId,
          status: { notIn: FINISHED },
          ...(document.delivery ? { id: { not: document.delivery.id } } : {}),
        },
        orderBy: { priority: 'desc' },
        select: { priority: true },
      });
      const priority = (last?.priority ?? 0) + 1;

      const delivery = document.delivery
        ? await tx.delivery.update({
            where: { id: document.delivery.id },
            data: { driverId, status: 'PLACED', priority, orderId: lineId },
          })
        : await tx.delivery.create({
            data: { documentId, orderId: lineId, driverId, status: 'PLACED', priority },
          });

      await tx.deliveryHistory.create({
        data: { deliveryId: delivery.id, status: 'PLACED', notes: 'Order assigned to driver' },
      });
      await tx.order.updateMany({
        where: { documentId },
        data: { driverId, deliveryStatus: 'NOT_STARTED' },
      });

      return delivery;
    });
  },

  /** Takes a whole order back off its driver and returns it to the pool. */
  async unassignOrder(documentId: string) {
    return prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findUnique({
        where: { documentId },
        select: { id: true, status: true, document: { select: { documentNumber: true } } },
      });
      if (delivery && FINISHED.includes(delivery.status)) {
        throw dispatchError(
          409,
          `${delivery.document?.documentNumber ?? 'This order'} is already ${delivery.status.toLowerCase()}.`
        );
      }

      if (delivery) {
        await tx.deliveryHistory.create({
          data: { deliveryId: delivery.id, status: 'UNASSIGNED', notes: 'Driver unassigned from order' },
        });
        await tx.delivery.update({
          where: { id: delivery.id },
          data: { driverId: null, status: 'UNASSIGNED' },
        });
      }
      await tx.order.updateMany({
        where: { documentId },
        data: { driverId: null, deliveryStatus: 'NOT_STARTED' },
      });

      return { success: true };
    });
  },

  /** For stops made before orders were dispatched whole, which name one line. */
  async assignDriver(orderId: string, driverId: string, priority: number = 1) {
    console.time(`Assignment-${orderId}`);
    // Check if delivery already exists for this order, or create new
    const existing = await prisma.delivery.findFirst({
      where: { orderId }
    });

    // A new assignment joins the end of the driver's run, not the front. The
    // driver only ever sees their first stop, so inserting at the top silently
    // redirects someone who may already be moving; dispatch reorders
    // deliberately by dragging instead.
    //
    // Scope is the driver's *open* work, not "created today". A delivery raised
    // yesterday and still not delivered is part of the run being ordered, and
    // ordering against `createdAt` skipped it.
    const lastDelivery = await prisma.delivery.findFirst({
      where: {
        driverId,
        status: { notIn: [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED] },
        ...(existing ? { id: { not: existing.id } } : {}),
      },
      orderBy: { priority: 'desc' },
    });

    // `reorderDeliveries` renumbers a run as 1..n, so the next free slot is
    // max + 1 and the two stay on one scheme.
    const priorityToUse = (lastDelivery?.priority ?? 0) + 1;

    let delivery;
    if (existing) {
      delivery = await prisma.delivery.update({
        where: { id: existing.id },
        data: {
          driverId,
          status: 'PLACED',
          priority: priorityToUse
        }
      });
    } else {
      delivery = await prisma.delivery.create({
        data: {
          orderId,
          driverId,
          status: 'PLACED',
          priority: priorityToUse
        }
      });
    }

    await prisma.deliveryHistory.create({
      data: {
        deliveryId: delivery.id,
        status: 'PLACED',
        notes: 'Order assigned to driver'
      }
    });

    await prisma.order.update({
      where: { id: orderId },
      data: {
        driverId,
        deliveryStatus: 'NOT_STARTED'
      }
    });

    console.timeEnd(`Assignment-${orderId}`);

    // Trigger assignment email in background (non-blocking)
    // MailService.sendAssignmentEmail(driverId, delivery.id).catch(err => {
    //   console.error('[MAIL] Background assignment email failed:', err);
    // });

    return delivery;
  },

  /** For stops made before orders were dispatched whole, which name one line. */
  async unassignDriver(orderId: string) {
    console.time(`Unassignment-${orderId}`);

    const existing = await prisma.delivery.findFirst({
      where: { orderId }
    });

    if (existing) {
      await prisma.deliveryHistory.create({
        data: {
          deliveryId: existing.id,
          status: 'UNASSIGNED',
          notes: 'Driver unassigned from order'
        }
      });

      await prisma.delivery.update({
        where: { id: existing.id },
        data: {
          driverId: null,
          status: 'UNASSIGNED'
        }
      });
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        driverId: null,
        deliveryStatus: 'NOT_STARTED'
      }
    });

    console.timeEnd(`Unassignment-${orderId}`);
    return { success: true };
  },

  async reorderDeliveries(driverId: string, deliveryIds: string[]) {
    // Update priorities for all deliveries in the list
    const updates = deliveryIds.map((id, index) => {
      return prisma.delivery.update({
        where: { id },
        data: { priority: index + 1 }
      });
    });

    await prisma.$transaction(updates);

    // Send priority update email in background
    // MailService.sendPriorityUpdateEmail(driverId).catch(err => {
    //   console.error('[MAIL] Background priority update email failed:', err);
    // });

    return { success: true };
  },

  async resendAssignmentEmail(deliveryId: string) {
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId }
    });
    if (!delivery || !delivery.driverId) {
      throw new Error('Delivery or driver not found');
    }
    return await MailService.sendAssignmentEmail(delivery.driverId, deliveryId);
  }
};
