import { Router } from 'express';
import { login, register } from './auth.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';

const router = Router();

// User creation is an administrative operation. The previous public route
// allowed an unauthenticated caller to choose ADMIN or OWNER for themselves.
router.post('/register', authMiddleware, requireRole(['ADMIN']), register);
router.post('/login', login);

export default router;
