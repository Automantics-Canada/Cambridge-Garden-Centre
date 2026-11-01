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
  expireRate,
  previewPriceListImport,
  commitPriceListImport,
  listProductAliases,
  addProductAlias,
  removeProductAlias
} from './supplier.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { UserRole } from '@prisma/client';
import multer from 'multer';
import { uploadErrorHandler } from '../../middleware/uploadValidation.js';
import { PRICE_LIST_MAX_BYTES } from './priceList.service.js';

const router = Router();

// A price list is a .csv or .xlsx of a few hundred rows. Neither has a magic
// number multer could check on the part header (an .xlsx is a ZIP, a CSV has
// none), so the content is checked by the spreadsheet reader instead; this only
// bounds the size and the count.
const priceListUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRICE_LIST_MAX_BYTES, files: 1, fields: 10 },
});

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
// Ends a rate's period instead of deleting it; the old price stays on record
// for the invoices it applied to.
router.post('/:id/rates/:rateId/expire', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), expireRate);
// Refused with 409 when the rate already priced an invoice line.
router.delete('/:id/rates/:rateId', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), removeRate);

// Price lists: preview writes nothing; the save repeats the preview and writes
// all rows or none. Same roles as single rates, because the effect is the same.
router.post(
  '/:id/rates/import/preview',
  requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]),
  priceListUpload.single('file'),
  previewPriceListImport
);
router.post(
  '/:id/rates/import',
  requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]),
  priceListUpload.single('file'),
  commitPriceListImport
);

// Product aliases: the confirmed mapping from a supplier's wording to one of
// our priced products. Same roles as rates, because an alias decides which rate
// applies and is therefore just as load-bearing on what gets paid.
router.get('/:id/aliases', listProductAliases);
router.post('/:id/aliases', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), addProductAlias);
router.delete('/:id/aliases/:aliasId', requireRole([UserRole.ADMIN, UserRole.OWNER, UserRole.AP_USER]), removeProductAlias);

// Oversized or malformed uploads become 413/400 with a message, not a 500.
router.use(uploadErrorHandler);

export default router;