import { prisma } from '../db/prisma.js';
// Replace with your actual email service import when available
// import { sendEmail } from './email.service.js';

export const NotificationService = {
  async sendAssignmentNotification(driverId: string, deliveries: any[]) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.email) {
      console.log(`No email for driver ${driverId}, skipping notification.`);
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const token = Buffer.from(`${driver.id}:${today}`).toString('base64');
    
    // Replace with your actual frontend URL
    const appUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const mobileLink = `${appUrl}/driver/today?token=${token}`;

    const subject = `You have ${deliveries.length} new deliveries assigned`;
    const body = `
      Hey ${driver.name},

      You have ${deliveries.length} deliveries assigned for today.

      Click the link below to access your mobile dispatch board:
      ${mobileLink}

      Safe driving!
    `;

    console.log(`[Notification] Sending email to ${driver.email}: ${subject}`);
    // await sendEmail(driver.email, subject, body);
  }
};
