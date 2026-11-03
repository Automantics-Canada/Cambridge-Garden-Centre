import { Router, type Response } from 'express';
import { UserRole } from '@prisma/client';
import { authMiddleware, requireRole, type AuthRequest } from '../../middleware/authMiddleware.js';
import { SpruceVendorService } from './spruceVendors.service.js';

/**
 * Spruce vendor codes, by supplier. Office roles only, like every supplier
 * route: which supplier a code bills as decides whose invoice a line is
 * matched against.
 *
 *   GET    /api/spruce-vendors/unmapped           codes on imported lines that map to nothing
 *   GET    /api/spruce-vendors?supplierId=…       one supplier's codes, retired ones included
 *   POST   /api/spruce-vendors   { supplierId, code }
 *   DELETE /api/spruce-vendors/:code?supplierId=… retire the code
 */
const router = Router();
const OFFICE = [UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN];

router.use(authMiddleware);
router.use(requireRole(OFFICE));

function supplierIdOf(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

router.get('/unmapped', async (_req: AuthRequest, res: Response) => {
  res.json(await SpruceVendorService.listUnmapped());
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const supplierId = supplierIdOf(req.query.supplierId);
  if (!supplierId) return res.status(400).json({ error: 'supplierId is required' });
  res.json(await SpruceVendorService.listForSupplier(supplierId));
});

router.post('/', requireRole(OFFICE), async (req: AuthRequest, res: Response) => {
  const supplierId = supplierIdOf(req.body?.supplierId);
  if (!supplierId) return res.status(400).json({ error: 'supplierId is required' });
  const saved = await SpruceVendorService.addCode(supplierId, req.body?.code, req.user!.id);
  res.status(saved.changed ? 201 : 200).json(saved);
});

router.delete('/:code', requireRole(OFFICE), async (req: AuthRequest, res: Response) => {
  const supplierId = supplierIdOf(req.query.supplierId);
  if (!supplierId) return res.status(400).json({ error: 'supplierId is required' });
  res.json(await SpruceVendorService.retireCode(supplierId, req.params.code, req.user!.id));
});

export default router;
