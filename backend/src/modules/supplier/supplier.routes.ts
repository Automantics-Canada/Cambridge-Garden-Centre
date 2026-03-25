import { Router } from 'express';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from './supplier.controller';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware';
import { UserRole } from '@prisma/client';

const router = Router();

// All supplier routes require login
router.use(authMiddleware);

// List: any logged-in AP_USER/OWNER/ADMIN can view
router.get('/', listSuppliers);

// Create/update/delete: restrict to ADMIN and OWNER for now
router.post('/', requireRole([UserRole.ADMIN, UserRole.OWNER]), createSupplier);
router.put('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), updateSupplier);
router.delete(
  '/:id',
  requireRole([UserRole.ADMIN, UserRole.OWNER]),
  deleteSupplier
);

export default router;
