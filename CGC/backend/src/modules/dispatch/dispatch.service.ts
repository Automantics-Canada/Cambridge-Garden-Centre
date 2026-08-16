import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import { MailService } from '../../services/mail.service.js';
import { businessDayOf, businessDayRange } from '../../lib/businessDay.js';

export const DispatchService = {
  /**
   * @param day 'YYYY-MM-DD' in the yard's timezone. Defaults to today there.
   */
  async getDispatchBoard(day?: string) {
    const requestedDay = day || businessDayOf();
    const dayRange = businessDayRange(requestedDay);
    if (!dayRange) {
      throw Object.assign(new Error(`Invalid date: ${requestedDay}`), { status: 400 });
    }

    // Scoped to one business day. This used to return every order that had
    // never been assigned, for all time, so the pool only ever grew and today's
    // work sat below months of stale rows.
    const unassignedOrders = await prisma.order.findMany({
      where: {
        deliveries: { none: {} },
        createdAt: { gte: dayRange.gte, lte: dayRange.lte },
      },
      include: {
        supplier: true
      }
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
            order: true,
            history: {
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      }
    });

    // We also need unassigned Deliveries if they exist without drivers
    const unassignedDeliveries = await prisma.delivery.findMany({
      where: { status: 'UNASSIGNED', driverId: null },
      include: {
        order: {
          include: { supplier: true }
        }
      }
    });

    return {
      unassignedOrders,
      unassignedDeliveries,
      drivers: drivers.map(d => ({
        ...d,
        deliveries: d.deliveries,
        todayDeliveries: d.deliveries.length,
        completedToday: d.deliveries.filter(del => del.status === 'DELIVERED').length
      }))
    };
  },

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
