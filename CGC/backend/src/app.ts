import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
import orderRoutes from './modules/orders/order.routes.js';
import ticketRoutes from './modules/tickets/ticket.routes.js';
import SupplierRoutes from './modules/supplier/supplier.routes.js';
import invoiceRoutes from './modules/invoices/invoice.routes.js';
import matchingRoutes from './modules/matching/matching.routes.js';
import productRoutes from './modules/products/product.routes.js';
import driverRoutes from './modules/drivers/driver.routes.js';
import dispatchRoutes from './modules/dispatch/dispatch.routes.js';
import deliveriesRoutes from './modules/deliveries/deliveries.routes.js';
import internalRoutes from './modules/internal/internal.routes.js';
import { buildInfo } from './config/buildInfo.js';
import {
  deriveWorkerHealth,
  readWorkerHeartbeat,
  type WorkerHeartbeat,
} from './workers/heartbeat.js';

const app = express();

/**
 * Allowed browser origins.
 *
 * This was a bare `cors()`, which sends `Access-Control-Allow-Origin: *` and
 * lets any page on the internet call the API from a logged-in user's browser.
 * The tokens here are bearer tokens in localStorage rather than cookies, so
 * this was not classic CSRF — but it did mean any site could probe the API and
 * read whatever an unauthenticated or misconfigured route returned.
 *
 * Set CORS_ALLOWED_ORIGINS to a comma-separated list in production. Requests
 * with no Origin header (server-to-server, curl, health checks) are allowed;
 * CORS only governs browsers.
 */
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    // An empty allowlist keeps local development working rather than locking
    // the developer out of their own machine. Production sets the variable.
    if (allowedOrigins.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        console.warn(`[CORS] CORS_ALLOWED_ORIGINS is unset; rejecting browser origin ${origin}`);
        return callback(null, false);
      }
      return callback(null, true);
    }

    return callback(null, allowedOrigins.includes(origin));
  },
  credentials: true,
}));
app.use(express.json());

// Serve static files from the uploads directory
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

/**
 * Liveness, plus which code the background worker is running.
 *
 * The `worker` block is the only place the worker service is visible at all.
 * It has no HTTP surface of its own, so a worker left behind on an older deploy
 * runs old logic against the current database with nothing on screen to say so.
 * See workers/heartbeat.ts for the failure that prompted this.
 *
 * Two properties this endpoint has to keep:
 *
 *   - **`status` never depends on the database.** Railway polls this to decide
 *     whether the API is healthy, so letting a database blip fail the check
 *     would restart-loop a perfectly good API. The heartbeat read is
 *     best-effort: a failure reports an unaccounted-for worker, not a sick API.
 *   - **It stays fast.** The read is raced against a short deadline for the
 *     same reason — an unreachable database must not hold a health check open.
 *
 * Still unauthenticated, and still discloses nothing an attacker gains from: a
 * short commit, a build time, and whether two of our own processes agree.
 */
const WORKER_HEARTBEAT_READ_TIMEOUT_MS = 1_500;

app.get('/api/health', async (_req, res) => {
  // The catch is on the read itself rather than around the race, so a failure
  // is logged even when the deadline wins and nobody is left waiting for it.
  // Logged rather than returned: the caller learns the worker is unaccounted
  // for, and the reason belongs in the server log.
  const read = readWorkerHeartbeat().catch((error: unknown) => {
    console.error('[Health] Could not read the worker heartbeat:', error);
    return null;
  });

  const heartbeat: WorkerHeartbeat | null = await Promise.race([
    read,
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), WORKER_HEARTBEAT_READ_TIMEOUT_MS).unref?.()
    ),
  ]);

  res.set('Cache-Control', 'no-store').json({
    status: 'ok',
    ...buildInfo,
    worker: deriveWorkerHealth(heartbeat, buildInfo.commit),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/suppliers', SupplierRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/matching', matchingRoutes);
app.use('/api/products', productRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/deliveries', deliveriesRoutes);
app.use('/api/internal', internalRoutes);


app.use(errorHandler);

export default app;

// trigger watch reload
