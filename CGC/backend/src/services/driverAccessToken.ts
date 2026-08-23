import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

interface LinkedDriverUser {
  id: string;
  email: string;
  role: string;
  active: boolean;
}

/** Creates the short-lived JWT accepted by authMiddleware for emailed links. */
export function createDriverAccessToken(user: LinkedDriverUser | null | undefined): string {
  if (!user?.active || user.role !== 'DRIVER') {
    throw new Error('Driver account is not linked or active');
  }

  return jwt.sign(
    { id: user.id, email: user.email, role: 'DRIVER' },
    env.jwtSecret,
    { expiresIn: '12h' },
  );
}

/**
 * Put the bearer token in the URL fragment. Fragments are handled by the
 * browser and are not sent in the HTTP request, reverse-proxy logs or Referer.
 */
export function buildDriverAccessUrl(appUrl: string, token: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}/driver/today#token=${encodeURIComponent(token)}`;
}
