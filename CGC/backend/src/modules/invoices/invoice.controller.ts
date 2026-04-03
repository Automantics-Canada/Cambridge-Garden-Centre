import type { Request, Response, NextFunction } from 'express';
import { InvoiceService } from './invoice.service.js';

export const InvoiceController = {
  async ingestMockEmail(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { fromEmail = 'supplier@example.com', subject = 'Invoice Attached' } = req.body;

      const { invoice, ocrJob } = await InvoiceService.ingestMockEmailInvoice({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        fromEmail,
        subject,
      });

      // Kick off OCR in the background, don't await
      InvoiceService.processInvoiceOcr(invoice.id).catch((err) => {
        console.error(`Background OCR failed for invoice ${invoice.id}:`, err);
      });

      res.status(202).json({
        message: 'Mock email ingested, invoice pending OCR',
        invoice,
        ocrJob,
      });
    } catch (error) {
      next(error);
    }
  },

  async getInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const { status, supplierId } = req.query;
      const filters: any = {};
      
      if (status) filters.status = status;
      if (supplierId) filters.supplierId = supplierId;

      const invoices = await InvoiceService.getInvoices(filters);
      res.json(invoices);
    } catch (error) {
      next(error);
    }
  },

  async getInvoiceById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const invoice = await InvoiceService.getInvoiceById(id);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      res.json(invoice);
    } catch (error) {
      next(error);
    }
  },

  async verifyInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      // Assuming authMiddleware attaches req.user
      const userId = (req as any).user?.userId; 
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const id = req.params.id as string;
      const updated = await InvoiceService.verifyInvoice(id, userId);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },

  async disputeInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      
      const { note } = req.body;

      const id = req.params.id as string;
      const updated = await InvoiceService.disputeInvoice(id, userId, note || 'Disputed by AP');
      res.json(updated);
    } catch (error) {
      next(error);
    }
  }
};
