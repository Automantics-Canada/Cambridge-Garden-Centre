import { Router } from 'express';
import {
  listSuppliers,
  listSupplierOptions,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  addRate,
  removeRate,
  updateRate,
  listProductAliases,
  addProductAlias,
  removeProductAlias
} from './supplier.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { UserRole } from '@prisma/client';

const router = Router();

router.use(authMiddleware);
router.use(requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]));

// Registered before '/' so the lean dropdown projection is reachable; both are
// operations-only via the router-level guard.
router.get('/options', listSupplierOptions);
router.get('/', listSuppliers);

router.post('/', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), createSupplier);
router.put('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), updateSupplier);
router.delete(
  '/:id',
  requireRole([UserRole.ADMIN, UserRole.OWNER]),
  deleteSupplier
);

router.post('/:id/rates', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), addRate);
router.patch('/:id/rates/:rateId', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), updateRate);
router.delete('/:id/rates/:rateId', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), removeRate);

// Product aliases: the confirmed mapping from a supplier's wording to one of
// our priced products. Same roles as rates, because an alias decides which rate
// applies and is therefore just as load-bearing on what gets paid.
router.get('/:id/aliases', listProductAliases);
router.post('/:id/aliases', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), addProductAlias);
router.delete('/:id/aliases/:aliasId', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), removeProductAlias);

export default router;