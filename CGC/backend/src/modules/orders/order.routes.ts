import { Router } from 'express';
import multer from 'multer';
import { importOrdersFromCsv, importOrdersFromPdf, getOrders, streamPdfImport, mergePoReport } from './order.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import {
  createUploader,
  validateUploadContent,
  uploadErrorHandler,
} from '../../middleware/uploadValidation.js';
import { rateLimit, limitConcurrency } from '../../middleware/rateLimit.js';
import { UserRole } from '@prisma/client';

const router = Router();

// CSV has no reliable magic-byte signature, so this path keeps the plain
// bounded multer instance and relies on the parser to reject malformed input.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// A PDF import fans out to one Textract call per page, so it is the most
// expensive endpoint in the service. Bound both rate and concurrency.
const pdfUpload = createUploader({ maxBytes: 5 * 1024 * 1024, kinds: ['pdf'] });

router.use(authMiddleware);
router.use(requireRole([UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN]));

router.get('/', getOrders);
router.get('/import/stream', streamPdfImport);

router.post(
  '/import',
  requireRole([UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN]),
  upload.single('file'),
  importOrdersFromCsv
);

router.post(
  '/import-pdf',
  requireRole([UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN]),
  rateLimit({ windowMs: 60_000, max: 5, name: 'PDF order import' }),
  limitConcurrency(2, 'PDF order import'),
  pdfUpload.single('file'),
  validateUploadContent(['pdf']),
  importOrdersFromPdf
);

// Step two of the Spruce import: merge the PO report onto documents already
// imported from the delivery report, joined on document number. Same rate and
// concurrency bounds as the delivery import — it is the same Textract cost.
router.post(
  '/merge-po-report',
  requireRole([UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN]),
  rateLimit({ windowMs: 60_000, max: 5, name: 'PO report merge' }),
  limitConcurrency(2, 'PO report merge'),
  pdfUpload.single('file'),
  validateUploadContent(['pdf']),
  mergePoReport
);

router.use(uploadErrorHandler);

export default router;