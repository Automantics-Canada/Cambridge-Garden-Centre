import { prisma } from '../../db/prisma.js';

export const DriverService = {
  async getDrivers() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const drivers = await prisma.driver.findMany({
      where: { active: true },
      include: {
        orders: {
          where: {
            orderDate: {
              gte: today,
              lt: tomorrow
            }
          }
        }
      }
    });

    // Transform to include task counts
    return drivers.map(driver => {
      const todayOrders = driver.orders;
      const completedOrders = todayOrders.filter(o => o.deliveryStatus === 'COMPLETED');
      const currentTask = todayOrders.find(o => o.deliveryStatus !== 'COMPLETED' && o.deliveryStatus !== 'NOT_STARTED') 
                        || todayOrders.find(o => o.deliveryStatus === 'NOT_STARTED');

      return {
        ...driver,
        stats: {
          totalToday: todayOrders.length,
          completedToday: completedOrders.length,
          progress: todayOrders.length > 0 ? Math.round((completedOrders.length / todayOrders.length) * 100) : 0
        },
        currentTask: currentTask || null
      };
    });
  },

  async createDriver(data: { name: string; phone: string; ratePerDelivery: number }) {
    return prisma.driver.create({
      data: {
        name: data.name,
        phone: data.phone,
        ratePerDelivery: data.ratePerDelivery,
        active: true
      }
    });
  },

  async getDriverDeliveries(driverId: string) {
    return prisma.order.findMany({
      where: { driverId },
      orderBy: { orderDate: 'desc' },
      include: {
        supplier: true,
        tickets: true
      }
    });
  }
};
