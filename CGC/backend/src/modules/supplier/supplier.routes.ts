import { Router } from 'express';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from './supplier.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { UserRole } from '@prisma/client';

const router = Router();

router.use(authMiddleware);

router.get('/', listSuppliers);

router.post('/', requireRole([UserRole.ADMIN, UserRole.OWNER]), createSupplier);
router.put('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), updateSupplier);
router.delete(
  '/:id',
  requireRole([UserRole.ADMIN, UserRole.OWNER]),
  deleteSupplier
);

export default router;