import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import { MailService } from '../../services/mail.service.js';
import { businessDayOf, businessDayRange } from '../../lib/businessDay.js';
import { DISPATCH_DOCUMENT_SELECT, representativeLineId, toDispatchOrder } from './dispatchOrderView.js';

/** A stop in either of these states is history, and is never reassigned. */
const FINISHED: DeliveryStatus[] = [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED];

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
   * @param day 'YYYY-MM-DD' in the yard's timezone. Defaults to today there.
   */
  async getDispatchBoard(day?: string) {
    const requestedDay = day || businessDayOf();
    const dayRange = businessDayRange(requestedDay);
    if (!dayRange) {
      throw Object.assign(new Error(`Invalid date: ${requestedDay}`), { status: 400 });
    }
    // Delivery dates are calendar dates, stored without a time.
    const deliveryDay = new Date(`${requestedDay}T00:00:00.000Z`);

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
              // Open work always shows: a stop raised on Monday and still not
              // delivered is live regardless of which day is being viewed.
              { status: { notIn: ['DELIVERED', 'CANCELLED'] } },
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
