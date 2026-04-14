import { Router } from 'express';
import multer from 'multer';
import { ingestWhatsappTicket, ingestEmailTicket, processTicketOcr, getTickets, getTicketStats, getTicketById, updateTicket, linkTicketToOrder, deleteTicket, getOcrJobStatus, processPendingOcrJobsEndpoint, } from './ticket.controller.js';
const router = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});
router.post('/whatsapp', upload.single('file'), ingestWhatsappTicket);
router.post('/email', upload.single('file'), ingestEmailTicket);
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
router.put('/:id', updateTicket);
router.delete('/:id', deleteTicket);
export default router;
//# sourceMappingURL=ticket.routes.js.map