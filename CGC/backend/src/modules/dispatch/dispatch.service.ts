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
          where: {
            startedAt: { gte: today }
          },
          include: {
            order: true
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
        todayDeliveries: d.deliveries.length,
        completedToday: d.deliveries.filter(del => del.status === 'DELIVERED').length
      }))
    };
  },

  async assignDriver(orderId: string, driverId: string, priority: number = 1) {
    // Check if delivery already exists for this order, or create new
    const existing = await prisma.delivery.findFirst({
      where: { orderId }
    });

    let priorityToUse = priority;
    if (!existing) {
      // Find the current max priority for this driver today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const lastDelivery = await prisma.delivery.findFirst({
        where: { 
          driverId,
          startedAt: { gte: today }
        },
        orderBy: { priority: 'desc' }
      });
      priorityToUse = (lastDelivery?.priority || 0) + 1;
    }

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

    // Add history entry
    await prisma.deliveryHistory.create({
      data: {
        deliveryId: delivery.id,
        status: 'PLACED',
        notes: 'Order assigned to driver'
      }
    });

    // Sync back to order for legacy compatibility
    await prisma.order.update({
      where: { id: orderId },
      data: {
        driverId,
        deliveryStatus: 'NOT_STARTED' // Mapping PLACED to NOT_STARTED for legacy
      }
    });

    // Send email to driver
    await MailService.sendAssignmentEmail(driverId, delivery.id);

    return delivery;
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

    // Send priority update email
    await MailService.sendPriorityUpdateEmail(driverId);

    return { success: true };
  }
};
