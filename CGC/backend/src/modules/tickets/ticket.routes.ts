import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import {
  createUploader,
  validateUploadContent,
  uploadErrorHandler,
} from '../../middleware/uploadValidation.js';
import { rateLimit, limitConcurrency } from '../../middleware/rateLimit.js';
import {
  ingestWhatsappTicket,
  ingestEmailTicket,
  uploadManualTicket,
  uploadManualPdfTickets,
  processTicketOcr,
  getTickets,
  getTicketStats,
  getTicketById,
  updateTicket,
  linkTicketToOrder,
  unlinkTicketFromOrder,
  deleteTicket,
  getOcrJobStatus,
  processPendingOcrJobsEndpoint,
} from './ticket.controller.js';

const router = Router();

const OPERATIONS = ['AP_USER', 'OWNER', 'ADMIN'] as const;

// Single ticket images stay small; multi-ticket PDFs need more headroom.
const imageUpload = createUploader({ maxBytes: 15 * 1024 * 1024, kinds: ['image', 'pdf'] });
const pdfUpload = createUploader({ maxBytes: 50 * 1024 * 1024, kinds: ['pdf'] });

// Every ingest path below reaches the extraction provider's API, so each one is
// rate limited in addition to being authenticated.
const ingestLimit = rateLimit({ windowMs: 60_000, max: 20, name: 'ticket ingest' });
const ocrLimit = rateLimit({ windowMs: 60_000, max: 10, name: 'ticket OCR' });
const ocrConcurrency = limitConcurrency(3, 'Ticket OCR');

// External ingestion must be moved behind provider-signature verification before
// it is re-enabled. Until then, require an authenticated operations role.
router.post('/whatsapp', authMiddleware, requireRole([...OPERATIONS]), ingestLimit, imageUpload.single('file'), validateUploadContent(['image', 'pdf']), ingestWhatsappTicket);

router.post('/email', authMiddleware, requireRole([...OPERATIONS]), ingestLimit, imageUpload.single('file'), validateUploadContent(['image', 'pdf']), ingestEmailTicket);

// Manual upload by admin (authenticated)
router.post('/upload', authMiddleware, requireRole([...OPERATIONS]), ingestLimit, imageUpload.single('file'), validateUploadContent(['image', 'pdf']), uploadManualTicket);

// Manual multi-ticket PDF upload (authenticated)
router.post('/upload-pdf', authMiddleware, requireRole([...OPERATIONS]), ingestLimit, pdfUpload.single('file'), validateUploadContent(['pdf']), uploadManualPdfTickets);

router.use(authMiddleware, requireRole([...OPERATIONS]));

router.post('/:id/process-ocr', ocrLimit, ocrConcurrency, processTicketOcr);

/**
 * OCR Job Management Routes
 */
router.get('/:ticketId/ocr-status', getOcrJobStatus); // Get OCR job status for a ticket
router.post('/jobs/process-pending', ocrLimit, ocrConcurrency, processPendingOcrJobsEndpoint); // Manually process pending OCR jobs

router.get('/stats', getTicketStats);
router.get('/', getTickets);
router.get('/:id', getTicketById);
router.post('/:id/link', linkTicketToOrder);
router.post('/:id/unlink', unlinkTicketFromOrder);
router.put('/:id', updateTicket);
router.delete('/:id', deleteTicket);

router.use(uploadErrorHandler);

export default router;
