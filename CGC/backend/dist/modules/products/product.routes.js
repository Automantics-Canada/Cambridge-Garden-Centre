import { Router } from 'express';
import { listProducts, createProduct, updateProduct, deleteProduct, listUnits, createUnit, deleteUnit, } from './product.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { UserRole } from '@prisma/client';
const router = Router();
router.use(authMiddleware);
router.get('/units', listUnits);
router.post('/units', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), createUnit);
router.delete('/units/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), deleteUnit);
router.get('/', listProducts);
router.post('/', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), createProduct);
router.put('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), updateProduct);
router.delete('/:id', requireRole([UserRole.ADMIN, UserRole.OWNER]), deleteProduct);
export default router;
//# sourceMappingURL=product.routes.js.map