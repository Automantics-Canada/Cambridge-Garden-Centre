import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
// import { UserRole } from '@prisma/client';

export type UserRole = 'AP_USER' | 'OWNER' | 'ADMIN';

export const register = async (req: Request, res: Response) => {
  const { email, password, name, role } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, name required' });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const allowedRoles: UserRole[] = ['AP_USER', 'OWNER', 'ADMIN'];
  if (role !== undefined && !allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'invalid role' });
  }

  const result = await AuthService.register(
    String(email).trim().toLowerCase(),
    password,
    String(name).trim(),
    role as UserRole | undefined
  );

  res.status(201).json({
    id: result.id,
    email: result.email,
    name: result.name,
    role: result.role,
  });
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const data = await AuthService.login(email, password);
  res.json(data);
};

//
