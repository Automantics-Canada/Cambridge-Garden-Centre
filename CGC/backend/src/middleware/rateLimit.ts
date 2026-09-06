/**
 * Request-rate and concurrency bounds for expensive endpoints.
 *
 * LIMITATION — read before relying on this.
 * State is held in this process only. With more than one Railway replica the
 * effective limit is `configured limit x replica count`, and it resets on every
 * deploy or restart. It bounds accidental loops and single-session abuse; it is
 * not a substitute for a gateway/WAF limit, and it does not stop a distributed
 * attacker. A shared-store limiter is the follow-up.
 *
 * Implemented without a new dependency deliberately: these routes are already
 * authenticated, so the value here is a cheap ceiling on paid OCR work rather
 * than a general-purpose edge limiter.
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuthRequest } from './authMiddleware.js';

interface WindowState {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests permitted per key per window. */
  max: number;
  /** Label used in the error message. */
  name: string;
}

/**
 * Identify the caller. Authenticated user id is preferred because it survives
 * NAT and shared egress addresses; the socket address is only a fallback for
 * unauthenticated routes.
 */
function callerKey(req: Request): string {
  const user = (req as AuthRequest).user;
  if (user?.id) return `user:${user.id}`;
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
}

export function rateLimit({ windowMs, max, name }: RateLimitOptions) {
  const windows = new Map<string, WindowState>();

  // Bounded sweep so the map cannot grow without limit on a long-lived process.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of windows) {
      if (state.resetAt <= now) windows.delete(key);
    }
  }, windowMs);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = callerKey(req);
    const now = Date.now();
    const state = windows.get(key);

    if (!state || state.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (state.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Too many ${name} requests. Retry in ${retryAfter}s.`,
      });
    }

    state.count += 1;
    next();
  };
}

/**
 * Caps simultaneous in-flight requests, which is what actually bounds parallel
 * model-API spend and keeps us inside the provider's rate limits. Rejects with
 * 503 rather than queueing so a caller gets a fast, explicit answer instead of
 * holding a connection open.
 */
export function limitConcurrency(max: number, name: string) {
  let inFlight = 0;

  return (_req: Request, res: Response, next: NextFunction) => {
    if (inFlight >= max) {
      res.setHeader('Retry-After', '30');
      return res.status(503).json({ error: `${name} is at capacity. Retry shortly.` });
    }

    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };

    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
