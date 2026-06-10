import { Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../../middleware/authMiddleware.js';
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

router.post('/whatsapp', upload.single('file'), ingestWhatsappTicket);

router.post('/email', upload.single('file'), ingestEmailTicket);

// Manual upload by admin (authenticated)
router.post('/upload', authMiddleware, upload.single('file'), uploadManualTicket);

// Manual multi-ticket PDF upload (authenticated)
router.post('/upload-pdf', authMiddleware, upload.single('file'), uploadManualPdfTickets);

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