import { Router } from 'express';
import { listSuppliers, createSupplier, updateSupplier, deleteSupplier, addRate, removeRate } from './supplier.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { UserRole } from '@prisma/client';
const router = Router();
router.use(authMiddleware);
router.get('/', listSuppliers);
router.post('/', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), createSupplier);
router.put('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), updateSupplier);
router.delete('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), deleteSupplier);
router.post('/:id/rates', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), addRate);
router.delete('/:id/rates/:rateId', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), removeRate);
export default router;
//# sourceMappingURL=supplier.routes.js.map