import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';

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

    let delivery;
    if (existing) {
      delivery = await prisma.delivery.update({
        where: { id: existing.id },
        data: {
          driverId,
          status: 'ASSIGNED',
          priority
        }
      });
    } else {
      delivery = await prisma.delivery.create({
        data: {
          orderId,
          driverId,
          status: 'ASSIGNED',
          priority
        }
      });
    }

    // Sync back to order for legacy compatibility
    await prisma.order.update({
      where: { id: orderId },
      data: {
        driverId,
        deliveryStatus: 'NOT_STARTED' // Mapping ASSIGNED to NOT_STARTED for legacy
      }
    });

    return delivery;
  }
};
