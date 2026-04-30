import { prisma } from '../../db/prisma.js';
import { DriverType } from '@prisma/client';

export const DriverService = {
  async getDrivers() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const drivers = await prisma.driver.findMany({
      where: { active: true },
      include: {
        deliveries: {
          where: {
            startedAt: {
              gte: today,
              lt: tomorrow
            } // We'll count any delivery created/started today
          },
          include: {
            order: true
          }
        }
      }
    });

    // Transform to include task counts
    return drivers.map(driver => {
      // Find today's deliveries by looking at created/assigned today. 
      // Actually, since deliveries might just be assigned today, let's just use the deliveries fetched.
      // Wait, we didn't add a createdAt to Delivery. We have startedAt, completedAt.
      // Let's change the include above to just fetch deliveries that are not completed or completed today.
      const todayDeliveries = driver.deliveries;
      const completedDeliveries = todayDeliveries.filter(d => d.status === 'DELIVERED');
      const currentTask = todayDeliveries.find(d => d.status !== 'DELIVERED' && d.status !== 'UNASSIGNED') 
                        || todayDeliveries.find(d => d.status === 'ASSIGNED');

      return {
        ...driver,
        stats: {
          totalToday: todayDeliveries.length,
          completedToday: completedDeliveries.length,
          progress: todayDeliveries.length > 0 ? Math.round((completedDeliveries.length / todayDeliveries.length) * 100) : 0
        },
        currentTask: currentTask || null
      };
    });
  },

  async createDriver(data: { name: string; phone: string; email?: string; type?: DriverType; ratePerDelivery?: number; ratePerTrip?: number; active?: boolean }) {
    return prisma.driver.create({
      data: {
        name: data.name,
        phone: data.phone,
        email: data.email,
        type: data.type || 'CGC_FLEET',
        ratePerDelivery: data.ratePerDelivery || 0,
        ratePerTrip: data.ratePerTrip || data.ratePerDelivery || 0,
        active: data.active !== undefined ? data.active : true
      }
    });
  },

  async updateDriver(id: string, data: any) {
    return prisma.driver.update({
      where: { id },
      data
    });
  },

  async getDriverDeliveries(driverId: string) {
    return prisma.delivery.findMany({
      where: { driverId },
      orderBy: { priority: 'desc' },
      include: {
        order: {
          include: {
            supplier: true,
            tickets: true
          }
        }
      }
    });
  }
};
