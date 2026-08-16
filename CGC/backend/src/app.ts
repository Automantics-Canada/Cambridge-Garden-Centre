import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
import orderRoutes from './modules/orders/order.routes.js';
import ticketRoutes from './modules/tickets/ticket.routes.js';
import SupplierRoutes from './modules/supplier/supplier.routes.js';
import invoiceRoutes from './modules/invoices/invoice.routes.js';
import productRoutes from './modules/products/product.routes.js';
import driverRoutes from './modules/drivers/driver.routes.js';
import dispatchRoutes from './modules/dispatch/dispatch.routes.js';
import deliveriesRoutes from './modules/deliveries/deliveries.routes.js';
import internalRoutes from './modules/internal/internal.routes.js';

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'LegionAutomations CGC Backend is running perfectly' });
});

app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/suppliers', SupplierRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/products', productRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/deliveries', deliveriesRoutes);
app.use('/api/internal', internalRoutes);


app.use(errorHandler);

export default app;

// trigger watch reload
