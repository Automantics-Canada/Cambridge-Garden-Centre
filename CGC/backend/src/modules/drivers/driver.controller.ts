import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { DriverService } from './driver.service.js';
import nodemailer from 'nodemailer';

export const getDrivers = async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role === 'DRIVER') {
      return res.status(403).json({ error: 'Access denied: Drivers cannot view all drivers' });
    }
    const drivers = await DriverService.getDrivers();
    res.json(drivers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getLoggedInDriverProfile = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const driver = await DriverService.getDriverByUserId(req.user.id);
    if (!driver) {
      return res.status(404).json({ error: 'Driver profile not found' });
    }
    res.json(driver);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

const fallbackNodemailer = async (email: string, name: string, password: string, html: string) => {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_PASS;

  if (!gmailUser || !gmailPass) {
    console.error('[NODEMAILER] Missing GMAIL_USER or GMAIL_PASS env variables. Direct email skipped.');
    return;
  }

  try {
    console.log(`[NODEMAILER] Attempting direct SMTP delivery to ${email}...`);
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPass
      }
    });

    await transporter.sendMail({
      from: `"CGC Dispatch" <${gmailUser}>`,
      to: email,
      subject: '🚚 Welcome to CGC! Your Driver Portal Credentials',
      html: html
    });

    console.log(`[NODEMAILER] Email successfully sent directly to ${email}!`);
  } catch (err) {
    console.error('[NODEMAILER] Direct delivery failed:', err);
  }
};

export const createDriver = async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, email, password, type, companyName, ratePerDelivery, ratePerTrip, active } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    const driver = await DriverService.createDriver({ 
      name, phone, email, password, type, companyName,
      ratePerDelivery: Number(ratePerDelivery || 0), 
      ratePerTrip: Number(ratePerTrip || ratePerDelivery || 0),
      active 
    });

    // Handle credential email delivery
    if (email && password) {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

      const html = `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a;">
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="display: inline-block; background: #2D6A4F; color: white; padding: 10px 20px; border-radius: 12px; font-weight: 800; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">
              CGC Logistics
            </div>
          </div>
          
          <h1 style="font-size: 24px; font-weight: 900; margin-bottom: 8px; color: #111; letter-spacing: -0.5px; text-align: center;">Welcome, ${name}!</h1>
          <p style="font-size: 16px; line-height: 1.6; color: #555; margin-bottom: 30px; text-align: center;">
            Your driver account has been created successfully. Below are your login credentials to access the CGC Driver Portal.
          </p>

          <div style="background: #f8f9fa; border: 1px solid #edf2f7; border-radius: 20px; padding: 24px; margin-bottom: 30px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom: 16px; border-bottom: 1px solid #edf2f7; padding-bottom: 12px;">
              <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Login Link</p>
              <p style="font-size: 15px; font-weight: 600; color: #2D6A4F; margin: 0;"><a href="${frontendUrl}/login" style="color: #2D6A4F; text-decoration: none;">${frontendUrl}/login</a></p>
            </div>
            <div style="margin-bottom: 16px;">
              <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Username / Email</p>
              <p style="font-size: 16px; font-weight: 700; color: #2d3748; margin: 0;">${email}</p>
            </div>
            <div>
              <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Password</p>
              <p style="font-size: 16px; font-weight: 700; color: #2d3748; margin: 0; font-family: monospace; background: #e2e8f0; padding: 6px 12px; border-radius: 8px; display: inline-block;">${password}</p>
            </div>
          </div>

          <div style="text-align: center; margin-bottom: 40px;">
            <a href="${frontendUrl}/login" style="display: inline-block; background: #2D6A4F; color: white; padding: 18px 36px; border-radius: 16px; font-weight: 800; text-decoration: none; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(45, 106, 79, 0.3);">
              LOG IN TO PORTAL
            </a>
          </div>

          <hr style="border: 0; border-top: 1px solid #edf2f7; margin-bottom: 30px;">
          
          <p style="font-size: 13px; color: #a0aec0; text-align: center; line-height: 1.6;">
            For security, please change your password or keep this email safe.<br>
            <strong>CGC Dispatch Team</strong>
          </p>
        </div>
      `;

      if (supabaseUrl && serviceRoleKey) {
        console.log(`[EDGE FUNCTION] Triggering credentials delivery for ${email}...`);
        fetch(`${supabaseUrl}/functions/v1/send-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`
          },
          body: JSON.stringify({ email, name, password })
        }).then(async (fnRes) => {
          const text = await fnRes.text();
          if (!fnRes.ok) {
            throw new Error(`Edge Function returned status ${fnRes.status}: ${text}`);
          }
          console.log(`[EDGE FUNCTION] send-credentials succeeded:`, text);
        }).catch(async (err) => {
          console.warn(`[EDGE FUNCTION] Failed (${err.message}). Falling back to direct Nodemailer...`);
          await fallbackNodemailer(email, name, password, html);
        });
      } else {
        console.log(`[NODEMAILER] Missing Supabase keys. Using direct Nodemailer delivery...`);
        fallbackNodemailer(email, name, password, html).catch(console.error);
      }
    }

    res.status(201).json(driver);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateDriver = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const data = req.body;
    
    // Convert to number if passed as string
    if (data.ratePerDelivery !== undefined) data.ratePerDelivery = Number(data.ratePerDelivery);
    if (data.ratePerTrip !== undefined) data.ratePerTrip = Number(data.ratePerTrip);

    const driver = await DriverService.updateDriver(id, data);
    res.json(driver);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getDriverDeliveries = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const deliveries = await DriverService.getDriverDeliveries(id);
    res.json(deliveries);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteDriver = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const result = await DriverService.deleteDriver(id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

