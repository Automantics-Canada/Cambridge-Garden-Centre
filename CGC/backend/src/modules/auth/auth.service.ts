import { prisma } from '../../db/prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
// import { UserRole } from '@prisma/client';

export type UserRole = 'AP_USER' | 'OWNER' | 'ADMIN';


export const AuthService = {
  async register(email: string, password: string, name: string, role?: UserRole) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw { status: 400, message: 'Email already in use' };
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hashed,
        name,
        role: role ?? 'AP_USER',
      },
    });

    return user;
  },

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw { status: 401, message: 'Invalid credentials' };
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      throw { status: 401, message: 'Invalid credentials' };
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      env.jwtSecret,
      { expiresIn: '7d' }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  },
};
