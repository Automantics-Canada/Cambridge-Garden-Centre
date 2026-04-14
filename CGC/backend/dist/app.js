import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
import orderRoutes from './modules/orders/order.routes.js';
import ticketRoutes from './modules/tickets/ticket.routes.js';
import SupplierRoutes from './modules/supplier/supplier.routes.js';
import invoiceRoutes from './modules/invoices/invoice.routes.js';
const app = express();
app.use(cors());
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
app.use(errorHandler);
export default app;
//# sourceMappingURL=app.js.map