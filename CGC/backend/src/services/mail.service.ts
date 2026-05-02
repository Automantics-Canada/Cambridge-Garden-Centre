import { prisma } from '../db/prisma.js';

export const MailService = {
  async sendEmail(to: string, subject: string, body: string) {
    console.log(`[MAIL] To: ${to}`);
    console.log(`[MAIL] Subject: ${subject}`);
    console.log(`[MAIL] Body: ${body}`);
    return { success: true };
  },

  async sendAssignmentEmail(driverId: string, deliveryId: string) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.email) return;

    const driverUrl = `${process.env.FRONTEND_URL}/driver/view/${deliveryId}`;
    
    await this.sendEmail(
      driver.email,
      'New Delivery Assigned',
      `You have a new delivery assignment. View details here: ${driverUrl}`
    );
  },

  async sendPriorityUpdateEmail(driverId: string) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.email) return;

    const driverUrl = `${process.env.FRONTEND_URL}/driver/deliveries`;

    await this.sendEmail(
      driver.email,
      'Delivery Priorities Updated',
      `Your delivery sequence has been updated. View your updated schedule here: ${driverUrl}`
    );
  }
};
