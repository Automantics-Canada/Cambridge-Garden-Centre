import type { Request, Response } from 'express';
import { TicketService } from './ticket.service.js';
import type {
  WhatsappTicketPayload,
  EmailTicketPayload,
} from './ticket.types.js';

export const ingestWhatsappTicket = async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  const { fromPhone } = req.body as WhatsappTicketPayload;

  if (!file) {
    return res.status(400).json({ error: 'file is required' });
  }
  if (!fromPhone) {
    return res.status(400).json({ error: 'fromPhone is required' });
  }

  try {
    const { ticket, ocrJob } = await TicketService.ingestWhatsappTicket({
      buffer: file.buffer,
      originalName: file.originalname,
      fromPhone,
    });

    return res.status(201).json({
      message: 'WhatsApp ticket received and queued for OCR',
      ticket,
      ocrJobId: ocrJob.id,
    });
  } catch (error: any) {
    console.error('ingestWhatsappTicket error', error);
    return res
      .status(500)
      .json({ error: error?.message ?? 'Unexpected error' });
  }
};

/**
 * Simulated email webhook:
 * multipart/form-data:
 *  - file: ticket image
 *  - fromEmail: sender email (e.g. "tickets@galtgravel.com")
 */
export const ingestEmailTicket = async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  const { fromEmail } = req.body as EmailTicketPayload;

  if (!file) {
    return res.status(400).json({ error: 'file is required' });
  }
  if (!fromEmail) {
    return res.status(400).json({ error: 'fromEmail is required' });
  }

  try {
    const { ticket, ocrJob } = await TicketService.ingestEmailTicket({
      buffer: file.buffer,
      originalName: file.originalname,
      fromEmail,
    });

    return res.status(201).json({
      message: 'Email ticket received and queued for OCR',
      ticket,
      ocrJobId: ocrJob.id,
    });
  } catch (error: any) {
    console.error('ingestEmailTicket error', error);
    return res
      .status(500)
      .json({ error: error?.message ?? 'Unexpected error' });
  }
};

export const processTicketOcr = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ticket = await TicketService.processTicketOcr(id as string);
    return res.status(200).json(ticket);
  } catch (error: any) {
    console.error('processTicketOcr error', error);
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};

export const getTickets = async (req: Request, res: Response) => {
  try {
    const { status, supplierId, source, startDate, endDate, search } = req.query;
    const filters: any = {};
    if (status) filters.status = status as any;
    if (supplierId) filters.supplierId = supplierId as string;
    if (source) filters.source = source as any;
    if (startDate) filters.startDate = startDate as string;
    if (endDate) filters.endDate = endDate as string;
    if (search) filters.search = search as string;

    const tickets = await TicketService.getTickets(filters);
    return res.status(200).json(tickets);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};

export const getTicketStats = async (req: Request, res: Response) => {
  try {
    const stats = await TicketService.getTicketStats();
    return res.status(200).json(stats);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};

export const getTicketById = async (req: Request, res: Response) => {
  try {
    const ticket = await TicketService.getTicketById(req.params.id as string);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.status(200).json(ticket);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};

export const linkTicketToOrder = async (req: Request, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }
    const userId = (req as any).user?.id; // Assuming auth middleware attaches user
    const ticket = await TicketService.linkTicketToOrder(req.params.id as string, orderId, userId);
    return res.status(200).json(ticket);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};

export const updateTicket = async (req: Request, res: Response) => {
  try {
    const ticket = await TicketService.updateTicket(req.params.id as string, req.body);
    return res.status(200).json(ticket);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};

export const deleteTicket = async (req: Request, res: Response) => {
  try {
    await TicketService.deleteTicket(req.params.id as string);
    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};