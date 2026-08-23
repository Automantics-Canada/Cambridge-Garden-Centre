import { prisma } from '../../db/prisma.js';
import { DriverType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

import { GmailService } from '../../services/gmail.service.js';

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
            createdAt: {
              gte: today,
              lt: tomorrow
            }
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
      const currentTask = todayDeliveries.find(d => 
        ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'DELAYED'].includes(d.status)
      );

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

  async createDriver(data: { 
    name: string; 
    phone: string; 
    email?: string; 
    password?: string;
    type?: DriverType; 
    companyName?: string;
    ratePerDelivery?: number; 
    ratePerTrip?: number; 
    active?: boolean;
    /** Controller-owned delivery can disable the service's email to avoid duplicates. */
    sendCredentials?: boolean;
  }) {
    const emailNormalized = data.email ? data.email.toLowerCase().trim() : undefined;
    const phoneNormalized = data.phone.trim();

    let plainPassword = data.password;
    if (plainPassword && plainPassword.length < 12) {
      throw new Error('Driver portal password must be at least 12 characters');
    }
    if (emailNormalized && !plainPassword) {
      plainPassword = `${randomBytes(18).toString('base64url')}Aa1!`;
    }

    const driver = await prisma.$transaction(async (tx) => {
      let userId: string | undefined = undefined;

      // 1. Check if phone number already exists in Driver table
      const existingDriverPhone = await tx.driver.findUnique({
        where: { phone: phoneNormalized }
      });
      if (existingDriverPhone) {
        throw new Error(`Phone number ${phoneNormalized} is already registered to another driver account.`);
      }

      if (emailNormalized) {
        // 2. Check if email already exists in Driver table
        const existingDriverEmail = await tx.driver.findFirst({
          where: { email: { equals: emailNormalized, mode: 'insensitive' } }
        });
        if (existingDriverEmail) {
          throw new Error(`Email ${emailNormalized} is already registered to another driver account.`);
        }

        // 3. Check if email already exists in User table
        const existingUser = await tx.user.findFirst({
          where: { email: { equals: emailNormalized, mode: 'insensitive' } },
          include: { driver: true }
        });

        if (existingUser) {
          // If the user already has an active Driver linked to it
          if (existingUser.driver) {
            throw new Error(`Email ${emailNormalized} is already registered and linked to another driver.`);
          }

          // If the user exists but is NOT linked to any Driver (dangling user), we can safely reuse and self-heal!
          console.log(`[SELF-HEALING] Reusing dangling User account (${existingUser.id}) for email ${emailNormalized}`);
          
          const updateData: any = {
            name: data.name,
            phone: phoneNormalized,
            role: 'DRIVER' as const,
            active: data.active !== undefined ? data.active : true
          };

          if (plainPassword) {
            updateData.passwordHash = await bcrypt.hash(plainPassword, 10);
          }

          await tx.user.update({
            where: { id: existingUser.id },
            data: updateData
          });

          userId = existingUser.id;
        } else {
          // Normal flow: User does not exist, so we create a new User
          if (plainPassword) {
            const hashed = await bcrypt.hash(plainPassword, 10);
            const user = await tx.user.create({
              data: {
                email: emailNormalized,
                passwordHash: hashed,
                name: data.name,
                role: 'DRIVER',
                phone: phoneNormalized,
                active: data.active !== undefined ? data.active : true
              }
            });
            userId = user.id;
          }
        }
      }

      const newDriver = await tx.driver.create({
        data: {
          name: data.name,
          phone: phoneNormalized,
          email: emailNormalized || null,
          type: data.type || 'CGC_FLEET',
          companyName: data.companyName || null,
          ratePerDelivery: data.ratePerDelivery || 0,
          ratePerTrip: data.ratePerTrip || data.ratePerDelivery || 0,
          active: data.active !== undefined ? data.active : true,
          userId: userId || null
        }
      });

      return newDriver;
    });

    if (emailNormalized && plainPassword && data.sendCredentials !== false) {
      try {
        const html = `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; text-align: center; color: #333;">
            <div style="background-color: #2b704d; color: white; display: inline-block; padding: 10px 20px; border-radius: 8px; font-weight: bold; font-size: 16px; letter-spacing: 1px; margin-bottom: 30px;">
              CGC LOGISTICS
            </div>
            
            <h1 style="font-size: 28px; margin-bottom: 20px;">Welcome, ${driver.name}!</h1>
            
            <p style="color: #666; font-size: 16px; line-height: 1.5; margin-bottom: 30px;">
              Your driver account has been created successfully. Below are your login credentials<br/>
              to access the CGC Driver Portal.
            </p>
            
            <div style="background-color: #f7f9fa; border-radius: 16px; padding: 30px; text-align: left; border: 1px solid #eaeaea;">
              <div style="margin-bottom: 20px;">
                <div style="font-size: 11px; font-weight: bold; color: #8e9bae; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;">LOGIN LINK</div>
                <a href="https://www.cambridgegardencentre.net/login/driver" style="color: #2b704d; font-size: 16px; font-weight: bold; text-decoration: none;">https://www.cambridgegardencentre.net/login/driver</a>
              </div>
              
              <div style="border-top: 1px solid #eaeaea; margin: 20px 0;"></div>
              
              <div style="margin-bottom: 20px;">
                <div style="font-size: 11px; font-weight: bold; color: #8e9bae; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;">USERNAME / EMAIL</div>
                <a href="mailto:${emailNormalized}" style="color: #1a56db; font-size: 16px; font-weight: bold; text-decoration: underline;">${emailNormalized}</a>
              </div>
              
              <div>
                <div style="font-size: 11px; font-weight: bold; color: #8e9bae; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;">PASSWORD</div>
                <div style="background-color: #e4e9f2; display: inline-block; padding: 8px 16px; border-radius: 6px; font-size: 16px; font-weight: bold; color: #333;">
                  ${plainPassword}
                </div>
              </div>
            </div>
          </div>
        `;
        await GmailService.sendEmail(emailNormalized, 'Welcome to CGC Driver Fleet', html);
      } catch (err) {
        console.error('Failed to send welcome email:', err);
      }
    }

    return driver;
  },

  async updateDriver(id: string, data: any) {
    const { name, phone, email, password, type, companyName, ratePerDelivery, ratePerTrip, active } = data;

    return prisma.$transaction(async (tx) => {
      // 1. Get the existing driver
      const existingDriver = await tx.driver.findUnique({
        where: { id },
        include: { user: true }
      });
      if (!existingDriver) {
        throw new Error(`Driver with ID ${id} not found`);
      }

      const driverUpdateData: any = {};
      if (name !== undefined) driverUpdateData.name = name;
      
      if (phone !== undefined) {
        const phoneNormalized = phone.trim();
        // Check if phone number already exists in Driver table for another driver
        const existingDriverPhone = await tx.driver.findFirst({
          where: { phone: phoneNormalized, id: { not: id } }
        });
        if (existingDriverPhone) {
          throw new Error(`Phone number ${phoneNormalized} is already registered to another driver account.`);
        }
        driverUpdateData.phone = phoneNormalized;
      }
      
      if (type !== undefined) driverUpdateData.type = type;
      if (companyName !== undefined) driverUpdateData.companyName = type === 'INDEPENDENT' ? companyName : null;
      if (ratePerDelivery !== undefined) driverUpdateData.ratePerDelivery = ratePerDelivery;
      if (ratePerTrip !== undefined) driverUpdateData.ratePerTrip = ratePerTrip;
      if (active !== undefined) driverUpdateData.active = active;

      const emailNormalized = email !== undefined && email !== null ? email.toLowerCase().trim() : undefined;
      
      if (emailNormalized !== undefined) {
        if (emailNormalized === '') {
          driverUpdateData.email = null;
          driverUpdateData.userId = null;
        } else {
          // Check if email already exists in Driver table for another driver
          const existingDriverEmail = await tx.driver.findFirst({
            where: { email: { equals: emailNormalized, mode: 'insensitive' }, id: { not: id } }
          });
          if (existingDriverEmail) {
            throw new Error(`Email ${emailNormalized} is already registered to another driver account.`);
          }
          driverUpdateData.email = emailNormalized;
        }
      }

      let userId = existingDriver.userId;

      if (password && password.length < 12) {
        throw new Error('Driver portal password must be at least 12 characters');
      }

      // Handle User table sync
      if (emailNormalized && emailNormalized !== '') {
        const hash = password ? await bcrypt.hash(password, 10) : undefined;

        if (userId) {
          // Update existing User
          const userUpdateData: any = {};
          if (name !== undefined) userUpdateData.name = name;
          if (phone !== undefined) userUpdateData.phone = phone.trim();
          userUpdateData.email = emailNormalized;
          if (hash) userUpdateData.passwordHash = hash;
          if (active !== undefined) userUpdateData.active = active;

          // Check if email exists on another User to avoid conflicts
          const existingUserWithEmail = await tx.user.findFirst({
            where: { email: { equals: emailNormalized, mode: 'insensitive' }, id: { not: userId } }
          });
          if (existingUserWithEmail) {
            throw new Error(`Email ${emailNormalized} is already registered to another user account.`);
          }

          await tx.user.update({
            where: { id: userId },
            data: userUpdateData
          });
        } else {
          // Create new User since driver didn't have a userId yet (but now has email)
          const existingUserWithEmail = await tx.user.findFirst({
            where: { email: { equals: emailNormalized, mode: 'insensitive' } }
          });
          if (existingUserWithEmail) {
            // Self-heal/link if dangling user with role DRIVER
            if (existingUserWithEmail.role === 'DRIVER') {
              const checkDriver = await tx.driver.findUnique({ where: { userId: existingUserWithEmail.id } });
              if (checkDriver) {
                throw new Error(`Email ${emailNormalized} is already registered and linked to another driver.`);
              }
              userId = existingUserWithEmail.id;
              
              const userUpdateData: any = {
                name: name !== undefined ? name : existingDriver.name,
                phone: phone !== undefined ? phone.trim() : existingDriver.phone,
                active: active !== undefined ? active : existingDriver.active
              };
              if (hash) userUpdateData.passwordHash = hash;
              await tx.user.update({
                where: { id: userId },
                data: userUpdateData
              });
            } else {
              throw new Error(`Email ${emailNormalized} is already registered with role ${existingUserWithEmail.role}.`);
            }
          } else {
            if (!hash) {
              throw new Error('A password is required when enabling login for an existing driver.');
            }
            const newUser = await tx.user.create({
              data: {
                email: emailNormalized,
                name: name !== undefined ? name : existingDriver.name,
                phone: phone !== undefined ? phone.trim() : existingDriver.phone,
                role: 'DRIVER',
                active: active !== undefined ? active : existingDriver.active,
                passwordHash: hash
              }
            });
            userId = newUser.id;
          }
          driverUpdateData.userId = userId;
        }
      } else if (userId && password) {
        // If email was not updated, but password was provided and userId exists
        const hash = await bcrypt.hash(password, 10);
        await tx.user.update({
          where: { id: userId },
          data: { passwordHash: hash }
        });
      }

      // 3. Update the Driver table
      return tx.driver.update({
        where: { id },
        data: driverUpdateData
      });
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
  },

  async getDriverByUserId(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const driver = await prisma.driver.findUnique({
      where: { userId },
      select: {
        id: true,
        name: true,
        type: true,
        phone: true,
        email: true,
        active: true,
        ratePerDelivery: true,
        ratePerTrip: true,
        userId: true,
        companyName: true,
      }
    });

    if (!driver) return null;

    const [totalToday, completedToday, currentTask] = await Promise.all([
      prisma.delivery.count({
        where: {
          driverId: driver.id,
          OR: [
            { status: { notIn: ['DELIVERED', 'CANCELLED'] } },
            { completedAt: { gte: today } },
          ],
        },
      }),
      prisma.delivery.count({
        where: { driverId: driver.id, status: 'DELIVERED', completedAt: { gte: today } },
      }),
      prisma.delivery.findFirst({
        where: { driverId: driver.id, status: { notIn: ['DELIVERED', 'CANCELLED'] } },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          priority: true,
          order: { select: { id: true, spruceOrderId: true, customerName: true } },
        },
      }),
    ]);

    return {
      ...driver,
      stats: {
        totalToday,
        completedToday,
        progress: totalToday > 0 ? Math.round((completedToday / totalToday) * 100) : 0
      },
      currentTask: currentTask || null
    };
  },

  async deleteDriver(id: string) {
    return prisma.$transaction(async (tx) => {
      // No `include: { user: true }` here. This record is returned straight to
      // the client by the controller, and the linked User carries passwordHash.
      // The cleanup below only needs the `userId` scalar, which Driver already has.
      const driver = await tx.driver.findUnique({
        where: { id }
      });
      if (!driver) throw new Error('Driver not found');

      // Set driverId to null in related records
      await tx.delivery.updateMany({
        where: { driverId: id },
        data: { driverId: null }
      });

      await tx.order.updateMany({
        where: { driverId: id },
        data: { driverId: null }
      });

      await tx.ticket.updateMany({
        where: { driverId: id },
        data: { driverId: null }
      });

      await tx.whatsAppMessage.updateMany({
        where: { driverId: id },
        data: { driverId: null }
      });

      // Delete the driver record
      await tx.driver.delete({
        where: { id }
      });

      // If there is an associated User record, delete it as well
      if (driver.userId) {
        await tx.user.delete({
          where: { id: driver.userId }
        });
      }

      return driver;
    });
  }
};

