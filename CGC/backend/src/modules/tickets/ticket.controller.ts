import type { Request, Response } from 'express';
import { TicketService } from './ticket.service.js';
import { processPendingOcrJobs } from '../../services/ocrJobProcessor.js';
import type {
  WhatsappTicketPayload,
  EmailTicketPayload,
} from './ticket.types.js';
import { PDFDocument } from 'pdf-lib';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { pdf } from 'pdf-to-img';

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

/**
 * Manual ticket upload by admin:
 * multipart/form-data:
 *  - file: ticket image (JPG/PNG)
 */
export const uploadManualTicket = async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;

  if (!file) {
    return res.status(400).json({ error: 'file is required' });
  }

  try {
    const { ticket, ocrJob } = await TicketService.ingestManualTicket({
      buffer: file.buffer,
      originalName: file.originalname,
    });

    return res.status(201).json({
      message: 'Ticket uploaded manually and queued for OCR',
      ticket,
      ocrJobId: ocrJob.id,
    });
  } catch (error: any) {
    console.error('uploadManualTicket error', error);
    return res
      .status(500)
      .json({ error: error?.message ?? 'Unexpected error' });
  }
};

/**
 * Manual multi-ticket PDF upload by admin:
 * 1. Splits the PDF into individual pages
 * 2. Converts each page to a PNG buffer
 * 3. Ingests each page individually as a separate ticket
 */
export const uploadManualPdfTickets = async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;

  console.log('[UploadPDF] Received request. File details:', {
    exists: !!file,
    originalname: file?.originalname,
    mimetype: file?.mimetype,
    size: file?.size,
    bufferExists: !!file?.buffer,
    bufferLength: file?.buffer?.length,
    bufferType: file?.buffer ? typeof file.buffer : 'undefined',
  });

  if (!file) {
    return res.status(400).json({ error: 'file is required' });
  }

  try {
    console.log(`[UploadPDF] Converting PDF buffer to image using pdf-to-img...`);
    let imageBuffer: Buffer;
    try {
      const document = await pdf(file.buffer, { scale: 3 });
      imageBuffer = await document.getPage(1);
    } catch (err) {
      console.error('[UploadPDF] Error converting PDF to image:', err);
      throw new Error('Failed to convert PDF to image using pdf-to-img');
    }

    const baseName = file.originalname.substring(0, file.originalname.lastIndexOf('.')) || file.originalname;
    const imageName = `${baseName}.png`;

    // Ingest the image buffer instead of the PDF and wait for OCR
    const { ticket, ocrJob } = await TicketService.ingestManualTicket({
      buffer: imageBuffer,
      originalName: imageName,
    }, true);

    return res.status(201).json({
      message: 'Successfully converted PDF and queued ticket for OCR',
      tickets: [ticket],
      ocrJobIds: [ocrJob.id],
    });
  } catch (error: any) {
    console.error('uploadManualPdfTickets error', error);
    try {
      const logFile = path.join(process.cwd(), 'debug_upload.log');
      fs.writeFileSync(logFile, `Error: ${error?.message}\nStack: ${error?.stack}\n`);
    } catch (logErr) {
      console.error('Failed to write debug log:', logErr);
    }
    return res
      .status(500)
      .json({ error: error?.message ?? 'Unexpected error during PDF upload and processing' });
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
    const { status, supplierId, source, startDate, endDate, search, page, limit } = req.query;
    const filters: any = {};
    if (status) filters.status = status as any;
    if (supplierId) filters.supplierId = supplierId as string;
    if (source) filters.source = source as any;
    if (startDate) filters.startDate = startDate as string;
    if (endDate) filters.endDate = endDate as string;
    if (search) filters.search = search as string;

    const pageNum = page ? parseInt(page as string) : undefined;
    const limitNum = limit ? parseInt(limit as string) : undefined;

    if (pageNum && limitNum) {
      filters.page = pageNum;
      filters.limit = limitNum;
    }

    const tickets = await TicketService.getTickets(filters);

    if (pageNum && limitNum) {
      const totalCount = await TicketService.countTickets(filters);
      return res.status(200).json({
        data: tickets,
        pagination: {
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(totalCount / limitNum),
          totalCount,
        }
      });
    }

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

export const unlinkTicketFromOrder = async (req: Request, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }
    await TicketService.unlinkTicketFromOrder(req.params.id as string, orderId);
    return res.status(204).send();
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

/**
 * Get OCR job status for a specific ticket
 * Returns the most recent OCR job and its current state
 */
export const getOcrJobStatus = async (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const ticket = await TicketService.getTicketById(ticketId as string);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (ticket.ocrJobs.length === 0) {
      return res.status(404).json({ error: 'No OCR jobs found for this ticket' });
    }
    // Return the most recent OCR job
    const latestJob = ticket.ocrJobs[0];
    return res.status(200).json(latestJob);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};

/**
 * Manually trigger processing of all pending OCR jobs
 * Useful for debugging, testing, or manual intervention
 * Admin only endpoint (optional, you can add auth middleware)
 */
export const processPendingOcrJobsEndpoint = async (req: Request, res: Response) => {
  try {
    const jobsProcessed = await processPendingOcrJobs();
    return res.status(200).json({
      message: `Started processing ${jobsProcessed} pending OCR jobs`,
      jobsProcessed,
    });
  } catch (error: any) {
    console.error('processPendingOcrJobsEndpoint error', error);
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};