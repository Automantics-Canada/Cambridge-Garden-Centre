import { Router } from 'express';
import multer from 'multer';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // Increase limit to 50MB for multi-page PDFs
});

// External ingestion must be moved behind provider-signature verification before
// it is re-enabled. Until then, require an authenticated operations role.
router.post('/whatsapp', authMiddleware, requireRole(['AP_USER', 'OWNER', 'ADMIN']), upload.single('file'), ingestWhatsappTicket);

router.post('/email', authMiddleware, requireRole(['AP_USER', 'OWNER', 'ADMIN']), upload.single('file'), ingestEmailTicket);

// Manual upload by admin (authenticated)
router.post('/upload', authMiddleware, requireRole(['AP_USER', 'OWNER', 'ADMIN']), upload.single('file'), uploadManualTicket);

// Manual multi-ticket PDF upload (authenticated)
router.post('/upload-pdf', authMiddleware, requireRole(['AP_USER', 'OWNER', 'ADMIN']), upload.single('file'), uploadManualPdfTickets);

router.use(authMiddleware, requireRole(['AP_USER', 'OWNER', 'ADMIN']));

router.post('/:id/process-ocr', processTicketOcr);

/**
 * OCR Job Management Routes
 */
router.get('/:ticketId/ocr-status', getOcrJobStatus); // Get OCR job status for a ticket
router.post('/jobs/process-pending', processPendingOcrJobsEndpoint); // Manually process pending OCR jobs

router.get('/stats', getTicketStats);
router.get('/', getTickets);
router.get('/:id', getTicketById);
router.post('/:id/link', linkTicketToOrder);
router.post('/:id/unlink', unlinkTicketFromOrder);
router.put('/:id', updateTicket);
router.delete('/:id', deleteTicket);

export default router;
