import { Router } from 'express';
import multer from 'multer';
import { importOrdersFromCsv, importOrdersFromPdf, getOrders, streamPdfImport, getPdfImportJob, mergePoReport } from './order.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import {
  createUploader,
  validateUploadContent,
  validateUploadedFiles,
  uploadErrorHandler,
} from '../../middleware/uploadValidation.js';
import { importSpruceReports, previewSpruceReport, REPORT_SLOTS } from './import/importBatch.controller.js';
import { editOrder, getOrderEditor, resetOrderField } from './edits/orderEdits.controller.js';
import { rateLimit, limitConcurrency } from '../../middleware/rateLimit.js';
import { UserRole } from '@prisma/client';

const router = Router();

// CSV has no reliable magic-byte signature, so this path keeps the plain
// bounded multer instance and relies on the parser to reject malformed input.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// A PDF import parses every page of the report in process, so it is the most
// expensive endpoint in the service. Bound both rate and concurrency.
const pdfUpload = createUploader({ maxBytes: 5 * 1024 * 1024, kinds: ['pdf'] });

// The morning's three reports, one per named slot. Spruce exports run to a
// few hundred kilobytes; 20 MB leaves room for a long day without inviting
// anything that is not a report.
const reportUpload = createUploader({ maxBytes: 20 * 1024 * 1024, kinds: ['pdf'], maxFiles: REPORT_SLOTS.length });
const reportPreviewUpload = createUploader({ maxBytes: 20 * 1024 * 1024, kinds: ['pdf'] });

router.use(authMiddleware);
router.use(requireRole([UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN]));

router.get('/', getOrders);
router.get('/import/stream', streamPdfImport);
// Poll a durable import job: for streams that died and browsers that reloaded.
router.get('/import/jobs/:jobId', getPdfImportJob);

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

// The three-report morning import. Preview reads one dropped file and writes
// nothing; import reads all of them, checks each is in its own slot, then
// merges them into one order per document.
router.post(
  '/import/reports/preview',
  rateLimit({ windowMs: 60_000, max: 30, name: 'Spruce report preview' }),
  // One per slot: the yard drops all three reports at once, and a third
  // refused as "at capacity" reads as a broken file.
  limitConcurrency(REPORT_SLOTS.length, 'Spruce report preview'),
  reportPreviewUpload.single('file'),
  validateUploadContent(['pdf']),
  previewSpruceReport
);

router.post(
  '/import/reports',
  rateLimit({ windowMs: 60_000, max: 5, name: 'Spruce report import' }),
  // One at a time: two imports of the same day would race on its orders.
  limitConcurrency(1, 'Spruce report import'),
  reportUpload.fields(REPORT_SLOTS.map(name => ({ name, maxCount: 1 }))),
  validateUploadedFiles(['pdf']),
  importSpruceReports
);

// A dispatcher's corrections to one order: what Spruce left out or got wrong
// about where it goes and what it is. Never prices, which Spruce owns.
router.get('/documents/:id', getOrderEditor);
router.patch('/documents/:id', editOrder);
router.post('/documents/:id/reset', resetOrderField);

// Step two of the Spruce import: merge the PO report onto documents already
// imported from the delivery report, joined on document number. Same rate and
// concurrency bounds as the delivery import — it is the same parsing cost.
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