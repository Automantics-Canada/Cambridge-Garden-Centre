import { InvoiceService } from './invoice.service.js';
import { triggerOcrProcessing } from '../../services/ocrJobProcessor.js';
export const InvoiceController = {
    async ingestMockEmail(req, res, next) {
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
                gmailMessageId: `manual-${Date.now()}`
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
        }
        catch (error) {
            next(error);
        }
    },
    async getInvoices(req, res, next) {
        try {
            const { status, supplierId } = req.query;
            const filters = {};
            if (status)
                filters.status = status;
            if (supplierId)
                filters.supplierId = supplierId;
            const invoices = await InvoiceService.getInvoices(filters);
            res.json(invoices);
        }
        catch (error) {
            next(error);
        }
    },
    async getInvoiceById(req, res, next) {
        try {
            const id = req.params.id;
            const invoice = await InvoiceService.getInvoiceById(id);
            if (!invoice)
                return res.status(404).json({ error: 'Invoice not found' });
            res.json(invoice);
        }
        catch (error) {
            next(error);
        }
    },
    async verifyInvoice(req, res, next) {
        try {
            // Assuming authMiddleware attaches req.user
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const id = req.params.id;
            const updated = await InvoiceService.verifyInvoice(id, userId);
            res.json(updated);
        }
        catch (error) {
            next(error);
        }
    },
    async disputeInvoice(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { note } = req.body;
            const id = req.params.id;
            const updated = await InvoiceService.disputeInvoice(id, userId, note || 'Disputed by AP');
            res.json(updated);
        }
        catch (error) {
            next(error);
        }
    },
    async reopenInvoice(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { reason } = req.body;
            const id = req.params.id;
            const updated = await InvoiceService.reopenInvoice(id, userId, reason || 'Reopened for review');
            res.json(updated);
        }
        catch (error) {
            next(error);
        }
    },
    async linkOrderToLineItem(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { lineItemId, orderId } = req.body;
            const updated = await InvoiceService.linkOrderToLineItem(lineItemId, orderId, userId);
            res.json(updated);
        }
        catch (error) {
            next(error);
        }
    },
    async linkTicketsToLineItem(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { lineItemId, ticketIds } = req.body;
            const updated = await InvoiceService.linkTicketsToLineItem(lineItemId, ticketIds, userId);
            res.json(updated);
        }
        catch (error) {
            next(error);
        }
    },
    async unlinkOrderFromLineItem(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { lineItemId } = req.body;
            const updated = await InvoiceService.unlinkOrderFromLineItem(lineItemId, userId);
            res.json(updated);
        }
        catch (error) {
            next(error);
        }
    },
    async unlinkTicketFromLineItem(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { lineItemId, ticketId } = req.body;
            const updated = await InvoiceService.unlinkTicketFromLineItem(lineItemId, ticketId, userId);
            res.json(updated);
        }
        catch (error) {
            next(error);
        }
    }
};
//# sourceMappingURL=invoice.controller.js.map