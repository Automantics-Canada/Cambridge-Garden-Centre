import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
export async function authMiddleware(req, res, next) {
    // Support legacy driver URL token access
    const queryToken = req.query.token;
    if (queryToken) {
        try {
            const decoded = Buffer.from(queryToken, 'base64').toString('ascii');
            const [driverId] = decoded.split(':');
            if (driverId) {
                const driver = await prisma.driver.findUnique({
                    where: { id: driverId }
                });
                if (driver) {
                    req.user = {
                        id: driver.userId || `legacy-driver-id-${driver.id}`,
                        email: driver.email || 'legacy@example.com',
                        role: 'DRIVER'
                    };
                    return next();
                }
            }
        }
        catch (e) {
            console.error('Failed to parse legacy driver token:', e);
        }
    }
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Missing token' });
    }
    try {
        const decoded = jwt.verify(token, env.jwtSecret);
        req.user = decoded;
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
export function requireRole(roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}
//# sourceMappingURL=authMiddleware.js.map