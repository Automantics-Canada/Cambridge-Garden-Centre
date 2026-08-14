import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { InvoiceStatus, SenderType } from '@prisma/client';
import { InvoiceService } from './invoice.service.js';
import { triggerOcrProcessing } from '../../services/ocrJobProcessor.js';

/** Signals a malformed query parameter, answered as 400 rather than 500. */
export class BadRequestError extends Error {}

/** `?page=` / `?limit=`; absent stays undefined so the service default applies. */
export function parseIntParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequestError('page and limit must be numbers');
  return parsed;
}

export function parseDateParam(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${name} is not a valid date`);
  return parsed;
}

/**
 * Cached pre-pagination frontend bundles call the endpoint with no query and
 * expect a bare array. Keep that bounded legacy shape during the rollout; all
 * current callers send page/limit and receive the paginated envelope.
 */
export function wantsLegacyInvoiceListShape(query: Request['query']): boolean {
  return Object.keys(query).length === 0;
}

/**
 * `Invoice.gmailMessageId` is @unique. Synthesising it from `Date.now()` meant
 * two uploads landing in the same millisecond collided on the constraint and
 * surfaced as an opaque 500, so locally-generated ids use a UUID instead.
 */
export function syntheticMessageId(prefix: string): string {
  return `${prefix}-${uuidv4()}`;
}

/** Prisma unique-constraint violation. */
export function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

export const InvoiceController = {
  async ingestMockEmail(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { fromEmail = 'supplier@example.com', subject = 'Invoice Attached' } = req.body;

      const { invoice, ocrJob } = await InvoiceService.ingestEmailInvoice({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        fromEmail,
        subject,
        gmailMessageId: syntheticMessageId('manual')
      });

      // Kick off OCR via unified processor
      if (ocrJob.id) {
        triggerOcrProcessing(ocrJob.id);
      }

      res.status(202).json({
        message: 'Mock email ingested, invoice pending OCR',
        invoice,
        ocrJob,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return res.status(409).json({ error: 'This invoice has already been ingested' });
      }
      next(error);
    }
  },

  /**
   * Staff dashboard upload. Sender fields are set server-side so this is not
   * a second copy of the ADMIN email simulator.
   */
  async ingestStaffUpload(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const originalName = req.file.originalname || 'invoice';
      const { invoice, ocrJob } = await InvoiceService.ingestEmailInvoice({
        buffer: req.file.buffer,
        originalName,
        fromEmail: 'staff_upload@cambridgegardencentre.ca',
        subject: `Manual Upload: ${originalName}`,
        gmailMessageId: syntheticMessageId('staff'),
      });

      if (ocrJob.id) {
        triggerOcrProcessing(ocrJob.id);
      }

      res.status(202).json({
        message: 'Invoice uploaded, pending OCR',
        invoice,
        ocrJob,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return res.status(409).json({ error: 'This invoice has already been ingested' });
      }
      next(error);
    }
  },

  async getInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const { status, supplierId, senderType, search, flaggedOnly, startDate, endDate, page, limit } =
        req.query;

      // An unparseable date must not silently widen the result set to the whole
      // ledger, so anything non-numeric/non-date is rejected rather than ignored.
      const parsedStart = parseDateParam(startDate, 'startDate');
      const parsedEnd = parseDateParam(endDate, 'endDate');

      const invoices = await InvoiceService.getInvoices({
        page: parseIntParam(page),
        limit: parseIntParam(limit),
        status: status ? (String(status) as InvoiceStatus) : undefined,
        supplierId: supplierId ? String(supplierId) : undefined,
        senderType: senderType ? (String(senderType) as SenderType) : undefined,
        search: search ? String(search) : undefined,
        flaggedOnly: flaggedOnly === 'true' || flaggedOnly === '1',
        startDate: parsedStart,
        endDate: parsedEnd,
      });
      res.json(wantsLegacyInvoiceListShape(req.query) ? invoices.data : invoices);
    } catch (error) {
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  },

  async getDashboardSummary(_req: Request, res: Response, next: NextFunction) {
    try {
      const summary = await InvoiceService.getDashboardSummary();
      res.json(summary);
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
      const userId = (req as any).user?.id; 
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
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      
      const { note } = req.body;

      const id = req.params.id as string;
      const updated = await InvoiceService.disputeInvoice(id, userId, note || 'Disputed by AP');
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },

  async reopenInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { reason } = req.body;
      const id = req.params.id as string;
      const updated = await InvoiceService.reopenInvoice(id, userId, reason || 'Reopened for review');
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },

  async linkOrderToLineItem(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { lineItemId, orderId } = req.body;
      const updated = await InvoiceService.linkOrderToLineItem(lineItemId, orderId, userId);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },

  async linkTicketsToLineItem(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { lineItemId, ticketIds } = req.body;
      const updated = await InvoiceService.linkTicketsToLineItem(lineItemId, ticketIds, userId);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },

  async unlinkOrderFromLineItem(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { lineItemId } = req.body;
      const updated = await InvoiceService.unlinkOrderFromLineItem(lineItemId, userId);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },

  async unlinkTicketFromLineItem(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { lineItemId, ticketId } = req.body;
      const updated = await InvoiceService.unlinkTicketFromLineItem(lineItemId, ticketId, userId);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  }
};

