import { prisma } from '../db/prisma.js';
import nodemailer from 'nodemailer';

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;
  
  transporter = nodemailer.createTransport(
    process.env.GMAIL_PASS 
      ? {
          service: 'gmail',
          auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS,
          },
        }
      : {
          service: 'gmail',
          auth: {
            type: 'OAuth2',
            user: process.env.GMAIL_USER,
            clientId: process.env.GMAIL_CLIENT_ID,
            clientSecret: process.env.GMAIL_CLIENT_SECRET,
            refreshToken: process.env.GMAIL_REFRESH_TOKEN,
          },
        }
  );
  return transporter;
}

export const MailService = {
  async sendEmail(to: string, subject: string, text: string, html?: string) {
    try {
      const info = await getTransporter().sendMail({
        from: `"CGC Dispatch" <${process.env.GMAIL_USER}>`,
        to,
        subject,
        text,
        html: html || text.replace(/\n/g, '<br>'),
      });
      console.log(`[MAIL] Email sent: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error: any) {
      console.error('[MAIL] Error sending email:', error);
      // Detailed error logging for common issues
      if (error.code === 'EAUTH') {
        console.error('[MAIL] AUTHENTICATION FAILED: Check GMAIL_REFRESH_TOKEN in .env');
      }
      return { success: false, error: error.message };
    }
  },

  async sendAssignmentEmail(driverId: string, deliveryId: string) {
    const [driver, delivery] = await Promise.all([
      prisma.driver.findUnique({ where: { id: driverId } }),
      prisma.delivery.findUnique({ 
        where: { id: deliveryId },
        include: { order: { include: { supplier: true } } }
      })
    ]);

    if (!driver) {
      console.error(`[MAIL] Driver not found: ${driverId}`);
      return { success: false, error: 'Driver not found' };
    }
    if (!driver.email) {
      console.warn(`[MAIL] No email registered for driver: ${driver.name}`);
      return { success: false, error: 'Driver has no registered email' };
    }
    if (!delivery) {
      console.error(`[MAIL] Delivery not found: ${deliveryId}`);
      return { success: false, error: 'Delivery not found' };
    }

    const today = new Date().toISOString().split('T')[0];
    const token = Buffer.from(`${driver.id}:${today}`).toString('base64');
    const appUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const driverUrl = `${appUrl}/driver/today?token=${token}`;
    
    const subject = `🚚 New Assignment: ${delivery.order.spruceOrderId} - Action Required`;
    const text = `Hey ${driver.name},\n\nYou have been assigned a new delivery task: ${delivery.order.spruceOrderId} for ${delivery.order.customerName}.\n\nView details: ${driverUrl}\n\nSafe driving!\nCGC Dispatch Team`;

    const html = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a;">
        <div style="text-align: center; margin-bottom: 30px;">
          <div style="display: inline-block; background: #2D6A4F; color: white; padding: 10px 20px; border-radius: 12px; font-weight: 800; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">
            CGC Logistics
          </div>
        </div>
        
        <h1 style="font-size: 24px; font-weight: 900; margin-bottom: 8px; color: #111; letter-spacing: -0.5px;">New Delivery Assigned</h1>
        <p style="font-size: 16px; line-height: 1.6; color: #555; margin-bottom: 30px;">
          Hey <strong>${driver.name}</strong>, you have a new delivery task ready for pickup.
        </p>

        <div style="background: #f8f9fa; border: 1px solid #edf2f7; border-radius: 20px; padding: 24px; margin-bottom: 30px;">
          <div style="margin-bottom: 16px;">
            <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Order ID</p>
            <p style="font-size: 18px; font-weight: 700; color: #2d3748; margin: 0;">${delivery.order.spruceOrderId}</p>
          </div>
          <div style="margin-bottom: 16px;">
            <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Customer</p>
            <p style="font-size: 16px; font-weight: 600; color: #2d3748; margin: 0;">${delivery.order.customerName}</p>
          </div>
          <div style="display: flex; gap: 20px;">
            <div style="flex: 1;">
              <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Product</p>
              <p style="font-size: 14px; font-weight: 600; color: #2d3748; margin: 0;">${delivery.order.product}</p>
            </div>
            <div style="flex: 1;">
              <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Quantity</p>
              <p style="font-size: 14px; font-weight: 600; color: #2d3748; margin: 0;">${Number(delivery.order.quantity)} ${delivery.order.unit}</p>
            </div>
          </div>
        </div>

        <div style="text-align: center; margin-bottom: 40px;">
          <a href="${driverUrl}" style="display: inline-block; background: #2D6A4F; color: white; padding: 18px 36px; border-radius: 16px; font-weight: 800; text-decoration: none; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(45, 106, 79, 0.3);">
            OPEN DRIVER PORTAL
          </a>
        </div>

        <hr style="border: 0; border-top: 1px solid #edf2f7; margin-bottom: 30px;">
        
        <p style="font-size: 13px; color: #a0aec0; text-align: center; line-height: 1.6;">
          Safe driving! If you have any issues with this assignment, please contact dispatch immediately.<br>
          <strong>CGC Dispatch Team</strong>
        </p>
      </div>
    `;

    return await this.sendEmail(driver.email, subject, text, html);
  },

  async sendPriorityUpdateEmail(driverId: string) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) return { success: false, error: 'Driver not found' };
    if (!driver.email) return { success: false, error: 'No email' };

    const today = new Date().toISOString().split('T')[0];
    const token = Buffer.from(`${driver.id}:${today}`).toString('base64');
    const appUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const driverUrl = `${appUrl}/driver/today?token=${token}`;

    const subject = `⚠️ Sequence Updated: Your Delivery Board has changed`;
    const text = `Hey ${driver.name},\n\nYour delivery sequence for today has been updated by dispatch.\n\nPlease check your updated schedule here: ${driverUrl}\n\nThank you!`;

    const html = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a;">
        <div style="text-align: center; margin-bottom: 30px;">
          <div style="display: inline-block; background: #fbbf24; color: #78350f; padding: 8px 16px; border-radius: 10px; font-weight: 800; font-size: 12px; letter-spacing: 1px; text-transform: uppercase;">
            Priority Update
          </div>
        </div>
        
        <h1 style="font-size: 24px; font-weight: 900; margin-bottom: 8px; color: #111; letter-spacing: -0.5px; text-align: center;">Schedule Updated</h1>
        <p style="font-size: 16px; line-height: 1.6; color: #555; margin-bottom: 30px; text-align: center;">
          Hey ${driver.name}, dispatch has reordered your delivery sequence for today.
        </p>

        <div style="text-align: center; margin-bottom: 40px;">
          <a href="${driverUrl}" style="display: inline-block; background: #1a1a1a; color: white; padding: 18px 36px; border-radius: 16px; font-weight: 800; text-decoration: none; font-size: 16px;">
            VIEW UPDATED BOARD
          </a>
        </div>

        <p style="font-size: 13px; color: #a0aec0; text-align: center;">
          Please pull over safely to review your new sequence before continuing.
        </p>
      </div>
    `;

    return await this.sendEmail(driver.email, subject, text, html);
  }
};
