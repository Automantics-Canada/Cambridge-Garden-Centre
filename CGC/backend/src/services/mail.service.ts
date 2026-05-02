import { prisma } from '../db/prisma.js';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.GMAIL_USER,
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
  },
});

export const MailService = {
  async sendEmail(to: string, subject: string, body: string) {
    try {
      const info = await transporter.sendMail({
        from: `"CGC Dispatch" <${process.env.GMAIL_USER}>`,
        to,
        subject,
        text: body,
      });
      console.log(`[MAIL] Email sent: ${info.messageId}`);
      return { success: true };
    } catch (error) {
      console.error('[MAIL] Error sending email:', error);
      return { success: false, error };
    }
  },

  async sendAssignmentEmail(driverId: string, deliveryId: string) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.email) return;

    const appUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const driverUrl = `${appUrl}/driver/view/${deliveryId}`;
    
    await this.sendEmail(
      driver.email,
      '🚚 New Delivery Assigned - Action Required',
      `Hey ${driver.name},

You have been assigned a new delivery task.

Please click the link below to view the details and mark your progress:
${driverUrl}

Safe driving!
CGC Dispatch Team`
    );
  },

  async sendPriorityUpdateEmail(driverId: string) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.email) return;

    const appUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const driverUrl = `${appUrl}/driver/today`;

    await this.sendEmail(
      driver.email,
      '⚠️ Delivery Priorities Updated',
      `Hey ${driver.name},

Your delivery sequence for today has been updated by dispatch.

Please check your updated schedule here:
${driverUrl}

Thank you!`
    );
  }
};
