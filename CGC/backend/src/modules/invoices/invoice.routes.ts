import { Router } from 'express';
import multer from 'multer';
import { InvoiceController } from './invoice.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Keep the simulator available for controlled troubleshooting, never publicly.
router.post('/mock-email', authMiddleware, requireRole(['ADMIN']), upload.single('file'), InvoiceController.ingestMockEmail);

// Protected routes
router.use(authMiddleware);
router.use(requireRole(['AP_USER', 'OWNER', 'ADMIN']));
router.get('/', InvoiceController.getInvoices);
router.get('/:id', InvoiceController.getInvoiceById);
router.post('/:id/verify', InvoiceController.verifyInvoice);
router.post('/:id/dispute', InvoiceController.disputeInvoice);
router.post('/:id/reopen', InvoiceController.reopenInvoice);
router.post('/line-items/link-order', InvoiceController.linkOrderToLineItem);
router.post('/line-items/link-tickets', InvoiceController.linkTicketsToLineItem);
router.post('/line-items/unlink-order', InvoiceController.unlinkOrderFromLineItem);
router.post('/line-items/unlink-ticket', InvoiceController.unlinkTicketFromLineItem);

export default router;
