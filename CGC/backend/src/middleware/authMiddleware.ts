import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Matches the UserRole enum in prisma/schema.prisma
// Once Prisma Client is generated, replace with: import { UserRole } from '@prisma/client';
export type UserRole = 'AP_USER' | 'OWNER' | 'ADMIN' | 'DRIVER';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
  };
}

import { prisma } from '../db/prisma.js';

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  // Support JWT via query parameter (e.g. for Server-Sent Events / EventSource)
  const queryToken = req.query.token as string;
  if (queryToken && queryToken.split('.').length === 3) {
    try {
      const decoded = jwt.verify(queryToken, env.jwtSecret) as unknown as {
        id: string;
        email: string;
        role: UserRole;
      };
      req.user = decoded;
      return next();
    } catch {
      // Let it fall through or fail
    }
  }

  // Support legacy driver URL token access
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
    } catch (e) {
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
    const decoded = jwt.verify(token, env.jwtSecret) as unknown as {
      id: string;
      email: string;
      role: UserRole;
    };
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
