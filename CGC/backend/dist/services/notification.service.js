import { prisma } from '../db/prisma.js';
import { MailService } from './mail.service.js';
export const NotificationService = {
    async sendAssignmentNotification(driverId, deliveries) {
        const driver = await prisma.driver.findUnique({ where: { id: driverId } });
        if (!driver || !driver.email) {
            console.log(`No email for driver ${driverId}, skipping notification.`);
            return;
        }
        const today = new Date().toISOString().split('T')[0];
        const token = Buffer.from(`${driver.id}:${today}`).toString('base64');
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
//# sourceMappingURL=notification.service.js.map