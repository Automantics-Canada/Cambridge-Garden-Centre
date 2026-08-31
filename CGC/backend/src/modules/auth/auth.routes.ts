import { Router } from 'express';
import { login, register } from './auth.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

const router = Router();

export function loginRateLimitKey(req: Request): string {
  const address = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const email = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase().slice(0, 254)
    : 'missing';
  const account = createHash('sha256').update(email).digest('hex');
  return `login:${address}:${account}`;
}

// User creation is an administrative operation. The previous public route
// allowed an unauthenticated caller to choose ADMIN or OWNER for themselves.
router.post('/register', authMiddleware, requireRole(['ADMIN']), register);
router.post(
  '/login',
  rateLimit({
    windowMs: 15 * 60_000,
    max: 10,
    name: 'login',
    // One user's mistakes must not lock every account behind the same office
    // NAT address. The address is still part of the key so the same identifier
    // receives an independent budget from each source.
    key: loginRateLimitKey,
  }),
  login
);

export default router;
