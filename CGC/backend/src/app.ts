import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'LegionAutomations CGC Backend is running perfectly' });
});

app.use('/api/auth', authRoutes);

// Global Error Handler
app.use(errorHandler);

export default app;
