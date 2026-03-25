import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
// import { UserRole } from '@prisma/client';

export type UserRole = 'AP_USER' | 'OWNER' | 'ADMIN';

export const register = async (req: Request, res: Response) => {
  const { email, password, name, role } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, name required' });
  }

  const result = await AuthService.register(
    email,
    password,
    name,
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
