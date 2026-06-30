import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import { MailService } from '../../services/mail.service.js';

export const DispatchService = {
  async getDispatchBoard() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const unassignedOrders = await prisma.order.findMany({
      where: { deliveries: { none: {} } },
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
              { status: { notIn: ['DELIVERED', 'CANCELLED'] } },
              { completedAt: { gte: today } }
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

    // Find the current lowest priority for this driver today to put this at the top
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstDelivery = await prisma.delivery.findFirst({
      where: { 
        driverId,
        createdAt: { gte: today }
      },
      orderBy: { priority: 'asc' }
    });
    
    // Assign a priority lower than the current lowest to place it at the top
    const priorityToUse = (firstDelivery?.priority || 0) - 1;

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
