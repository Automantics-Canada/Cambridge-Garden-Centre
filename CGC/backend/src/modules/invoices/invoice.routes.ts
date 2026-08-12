import { Router } from 'express';
import { InvoiceController } from './invoice.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import {
  createUploader,
  validateUploadContent,
  uploadErrorHandler,
} from '../../middleware/uploadValidation.js';
import { rateLimit } from '../../middleware/rateLimit.js';

const router = Router();
// The invoice upload UI offers .jpg/.jpeg/.png/.pdf.
const upload = createUploader({ maxBytes: 15 * 1024 * 1024, kinds: ['image', 'pdf'] });

// Keep the simulator available for controlled troubleshooting, never publicly.
// It persists an invoice and triggers paid OCR, so it is rate limited too.
router.post(
  '/mock-email',
  authMiddleware,
  requireRole(['ADMIN']),
  rateLimit({ windowMs: 60_000, max: 10, name: 'invoice ingest' }),
  upload.single('file'),
  validateUploadContent(['image', 'pdf']),
  InvoiceController.ingestMockEmail
);

// Protected routes
router.use(authMiddleware);
router.use(requireRole(['AP_USER', 'OWNER', 'ADMIN']));
router.post(
  '/upload',
  rateLimit({ windowMs: 60_000, max: 10, name: 'invoice ingest' }),
  upload.single('file'),
  validateUploadContent(['image', 'pdf']),
  InvoiceController.ingestStaffUpload
);
router.get('/', InvoiceController.getInvoices);
router.get('/:id', InvoiceController.getInvoiceById);
router.post('/:id/verify', InvoiceController.verifyInvoice);
router.post('/:id/dispute', InvoiceController.disputeInvoice);
router.post('/:id/reopen', InvoiceController.reopenInvoice);
router.post('/line-items/link-order', InvoiceController.linkOrderToLineItem);
router.post('/line-items/link-tickets', InvoiceController.linkTicketsToLineItem);
router.post('/line-items/unlink-order', InvoiceController.unlinkOrderFromLineItem);
router.post('/line-items/unlink-ticket', InvoiceController.unlinkTicketFromLineItem);

router.use(uploadErrorHandler);

export default router;
