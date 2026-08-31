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
import { resolveActiveUser } from '../services/authorization.js';

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
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
    const currentUser = await resolveActiveUser(prisma, decoded.id);
    if (!currentUser) {
      return res.status(401).json({ error: 'Account is inactive' });
    }
    req.user = currentUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/** A role guard, carrying the roles it allows so route wiring can be asserted. */
export interface RoleGuard {
  (req: AuthRequest, res: Response, next: NextFunction): void;
  allowedRoles: readonly UserRole[];
}

export function requireRole(roles: UserRole[]): RoleGuard {
  const guard = function requireRoleMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  } as RoleGuard;

  // Exposed so the route-guard regression test can assert exactly which roles
  // each endpoint admits, rather than only that some guard is present.
  guard.allowedRoles = Object.freeze([...roles]);
  return guard;
}
