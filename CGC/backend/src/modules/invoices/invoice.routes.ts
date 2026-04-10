import { Router } from 'express';
import multer from 'multer';
import { InvoiceController } from './invoice.controller.js';
import { authMiddleware } from '../../middleware/authMiddleware.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Mock endpoint for simulating email receipt from Gmail API (no auth needed for testing webhook simulation)
router.post('/mock-email', upload.single('file'), InvoiceController.ingestMockEmail);

// Protected routes
router.use(authMiddleware);
router.get('/', InvoiceController.getInvoices);
router.get('/:id', InvoiceController.getInvoiceById);
router.post('/:id/verify', InvoiceController.verifyInvoice);
router.post('/:id/dispute', InvoiceController.disputeInvoice);
router.post('/:id/reopen', InvoiceController.reopenInvoice);

export default router;
