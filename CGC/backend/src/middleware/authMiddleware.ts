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
      const currentUser = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, email: true, role: true, active: true },
      });
      if (!currentUser?.active) {
        return res.status(401).json({ error: 'Account is inactive' });
      }
      req.user = {
        id: currentUser.id,
        email: currentUser.email,
        role: currentUser.role as UserRole,
      };
      return next();
    } catch {
      // Let it fall through or fail
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
    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true, active: true },
    });
    if (!currentUser?.active) {
      return res.status(401).json({ error: 'Account is inactive' });
    }
    req.user = {
      id: currentUser.id,
      email: currentUser.email,
      role: currentUser.role as UserRole,
    };
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
