import { Router } from 'express';
import multer from 'multer';
import {
  ingestWhatsappTicket,
  ingestEmailTicket,
  processTicketOcr,
  getTickets,
  getTicketById,
  updateTicket,
  deleteTicket,
} from './ticket.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

router.post('/whatsapp', upload.single('file'), ingestWhatsappTicket);

router.post('/email', upload.single('file'), ingestEmailTicket);

router.post('/:id/process-ocr', processTicketOcr);

router.get('/', getTickets);
router.get('/:id', getTicketById);
router.put('/:id', updateTicket);
router.delete('/:id', deleteTicket);

export default router;