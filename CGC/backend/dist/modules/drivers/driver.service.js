import { prisma } from '../../db/prisma.js';
import { DriverType } from '@prisma/client';
import bcrypt from 'bcryptjs';
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
            const currentTask = todayDeliveries.find(d => ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'DELAYED'].includes(d.status));
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
    async createDriver(data) {
        const emailNormalized = data.email ? data.email.toLowerCase().trim() : undefined;
        const phoneNormalized = data.phone.trim();
        return prisma.$transaction(async (tx) => {
            let userId = undefined;
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
                    const updateData = {
                        name: data.name,
                        phone: phoneNormalized,
                        role: 'DRIVER',
                        active: data.active !== undefined ? data.active : true
                    };
                    if (data.password) {
                        updateData.passwordHash = await bcrypt.hash(data.password, 10);
                    }
                    await tx.user.update({
                        where: { id: existingUser.id },
                        data: updateData
                    });
                    userId = existingUser.id;
                }
                else {
                    // Normal flow: User does not exist, so we create a new User
                    if (data.password) {
                        const hashed = await bcrypt.hash(data.password, 10);
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
            const driver = await tx.driver.create({
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
            return driver;
        });
    },
    async updateDriver(id, data) {
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
            const driverUpdateData = {};
            if (name !== undefined)
                driverUpdateData.name = name;
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
            if (type !== undefined)
                driverUpdateData.type = type;
            if (companyName !== undefined)
                driverUpdateData.companyName = type === 'INDEPENDENT' ? companyName : null;
            if (ratePerDelivery !== undefined)
                driverUpdateData.ratePerDelivery = ratePerDelivery;
            if (ratePerTrip !== undefined)
                driverUpdateData.ratePerTrip = ratePerTrip;
            if (active !== undefined)
                driverUpdateData.active = active;
            const emailNormalized = email !== undefined && email !== null ? email.toLowerCase().trim() : undefined;
            if (emailNormalized !== undefined) {
                if (emailNormalized === '') {
                    driverUpdateData.email = null;
                    driverUpdateData.userId = null;
                }
                else {
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
            // Handle User table sync
            if (emailNormalized && emailNormalized !== '') {
                const hash = password ? await bcrypt.hash(password, 10) : undefined;
                if (userId) {
                    // Update existing User
                    const userUpdateData = {};
                    if (name !== undefined)
                        userUpdateData.name = name;
                    if (phone !== undefined)
                        userUpdateData.phone = phone.trim();
                    userUpdateData.email = emailNormalized;
                    if (hash)
                        userUpdateData.passwordHash = hash;
                    if (active !== undefined)
                        userUpdateData.active = active;
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
                }
                else {
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
                            const userUpdateData = {
                                name: name !== undefined ? name : existingDriver.name,
                                phone: phone !== undefined ? phone.trim() : existingDriver.phone,
                                active: active !== undefined ? active : existingDriver.active
                            };
                            if (hash)
                                userUpdateData.passwordHash = hash;
                            await tx.user.update({
                                where: { id: userId },
                                data: userUpdateData
                            });
                        }
                        else {
                            throw new Error(`Email ${emailNormalized} is already registered with role ${existingUserWithEmail.role}.`);
                        }
                    }
                    else {
                        const newUser = await tx.user.create({
                            data: {
                                email: emailNormalized,
                                name: name !== undefined ? name : existingDriver.name,
                                phone: phone !== undefined ? phone.trim() : existingDriver.phone,
                                role: 'DRIVER',
                                active: active !== undefined ? active : existingDriver.active,
                                passwordHash: hash || await bcrypt.hash('CgcDriver123!', 10)
                            }
                        });
                        userId = newUser.id;
                    }
                    driverUpdateData.userId = userId;
                }
            }
            else if (userId && password) {
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
    async getDriverDeliveries(driverId) {
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
    async getDriverByUserId(userId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const driver = await prisma.driver.findUnique({
            where: { userId },
            include: {
                deliveries: {
                    where: {
                        OR: [
                            { status: { notIn: ['DELIVERED', 'CANCELLED'] } },
                            { completedAt: { gte: today } }
                        ]
                    },
                    include: {
                        order: {
                            include: { supplier: true }
                        }
                    }
                }
            }
        });
        if (!driver)
            return null;
        const todayDeliveries = driver.deliveries;
        const completedDeliveries = todayDeliveries.filter(d => d.status === 'DELIVERED');
        const currentTask = todayDeliveries.find(d => ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'DELAYED'].includes(d.status));
        return {
            ...driver,
            stats: {
                totalToday: todayDeliveries.length,
                completedToday: completedDeliveries.length,
                progress: todayDeliveries.length > 0 ? Math.round((completedDeliveries.length / todayDeliveries.length) * 100) : 0
            },
            currentTask: currentTask || null
        };
    }
};
//# sourceMappingURL=driver.service.js.map