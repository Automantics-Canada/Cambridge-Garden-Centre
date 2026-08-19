import { prisma } from '../db/prisma.js';
import { MailService } from './mail.service.js';
import { createDriverAccessToken } from './driverAccessToken.js';

export const NotificationService = {
  async sendAssignmentNotification(driverId: string, deliveries: any[]) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { user: true } });
    if (!driver || !driver.email) {
      console.log(`No email for driver ${driverId}, skipping notification.`);
      return;
    }

    let token: string;
    try {
      token = createDriverAccessToken(driver.user);
    } catch (error: any) {
      console.log(`${error.message}; skipping notification for ${driverId}.`);
      return;
    }
    
    const appUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const mobileLink = `${appUrl}/driver/today?token=${token}`;

    const subject = `🚚 You have ${deliveries.length} new deliveries assigned`;
    const body = `
Hey ${driver.name},

You have ${deliveries.length} deliveries assigned for today.

Click the link below to access your mobile dispatch board:
${mobileLink}

Safe driving!
CGC Dispatch Team
    `;

    await MailService.sendEmail(driver.email, subject, body);
  }
};
