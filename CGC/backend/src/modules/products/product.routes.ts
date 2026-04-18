import { Router } from 'express';
import {
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} from './product.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { UserRole } from '@prisma/client';

const router = Router();

router.use(authMiddleware);

router.get('/', listProducts);
router.post('/', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), createProduct);
router.put('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), updateProduct);
router.delete('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), deleteProduct);

export default router;
