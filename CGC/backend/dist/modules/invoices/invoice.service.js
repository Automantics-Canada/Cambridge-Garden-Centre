import { prisma } from '../../db/prisma.js';
import { saveInvoiceImage } from '../../services/fileStorage.js';
import { extractExpenseFromLocalImage } from '../../services/invoiceOcr.service.js';
import { InvoiceStatus, SenderType, OcrJobType, OcrProvider, OcrJobStatus, LineItemFlag, AuditEntityType, AuditActionType, } from '@prisma/client';
async function findSupplierByName(name) {
    if (!name)
        return null;
    const supplier = await prisma.supplier.findFirst({
        where: {
            name: { contains: name, mode: 'insensitive' },
        },
    });
    return supplier;
}
/**
 * Normalizes product names for fuzzy matching.
 * e.g., "Type A Gravel" -> "a gravel"
 */
function normalizeString(str) {
    return str
        .toLowerCase()
        .replace(/type\s+/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function stringsMatchFuzzy(a, b) {
    const normA = normalizeString(a);
    const normB = normalizeString(b);
    return normA.includes(normB) || normB.includes(normA);
}
export const InvoiceService = {
    async ingestMockEmailInvoice(params) {
        const fileUrl = await saveInvoiceImage(params.buffer, params.originalName);
        // Mock finding a supplier by email domain
        const match = params.fromEmail.match(/@(.+)$/);
        const domain = match && match[1] ? match[1] : '';
        let supplier = await prisma.supplier.findFirst({
            where: domain ? { emailDomains: { hasSome: [domain] } } : {},
        });
        if (!supplier) {
            supplier = await prisma.supplier.findFirst();
        }
        if (!supplier)
            throw new Error('No supplier found in the system to link to');
        const invoice = await prisma.invoice.create({
            data: {
                invoiceNumber: `MOCK-${Date.now()}`,
                senderType: SenderType.SUPPLIER,
                supplierId: supplier.id,
                invoiceDate: new Date(),
                totalAmount: 0,
                currency: 'CAD',
                fileUrl,
                emailFrom: params.fromEmail,
                emailSubject: params.subject,
                gmailMessageId: `mock-gmail-${Date.now()}`,
                status: InvoiceStatus.PENDING_REVIEW,
                OcrJobStatus: OcrJobStatus.PENDING,
            },
        });
        const ocrJob = await prisma.ocrJob.create({
            data: {
                type: OcrJobType.INVOICE,
                provider: OcrProvider.AWS_TEXTRACT,
                status: OcrJobStatus.PENDING,
                invoiceId: invoice.id,
            },
        });
        return { invoice, ocrJob };
    },
    async processInvoiceOcr(invoiceId) {
        const invoice = await prisma.invoice.findUnique({
            where: { id: invoiceId },
            include: { ocrJobs: { orderBy: { startedAt: 'desc' }, take: 1 } },
        });
        if (!invoice)
            throw new Error('Invoice not found');
        const ocrJob = invoice.ocrJobs[0];
        if (ocrJob) {
            await prisma.ocrJob.update({
                where: { id: ocrJob.id },
                data: { status: OcrJobStatus.PROCESSING, startedAt: new Date() },
            });
        }
        try {
            const extracted = await extractExpenseFromLocalImage(invoice.fileUrl);
            let updatedSupplierId = invoice.supplierId;
            if (extracted.supplierName) {
                const found = await findSupplierByName(extracted.supplierName);
                if (found)
                    updatedSupplierId = found.id;
            }
            const updatedInvoice = await prisma.invoice.update({
                where: { id: invoiceId },
                data: {
                    supplierId: updatedSupplierId,
                    invoiceNumber: extracted.invoiceNumber || invoice.invoiceNumber,
                    invoiceDate: extracted.invoiceDate || invoice.invoiceDate,
                    totalAmount: extracted.totalAmount || invoice.totalAmount,
                    ocrRawText: JSON.stringify(extracted.rawResponse),
                    OcrJobStatus: OcrJobStatus.COMPLETED,
                },
            });
            // Clear existing line items
            await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
            for (let i = 0; i < extracted.lineItems.length; i++) {
                const item = extracted.lineItems[i];
                if (!item)
                    continue;
                let matchedOrderId = null;
                let matchedTicketId = null;
                let negotiatedRateVal = null;
                let flags = [];
                let rateDiscrepancy = null;
                let qtyDiscrepancy = null;
                // --- MATCH 1: Invoice Line to Ticket ---
                if (item.poNumber) {
                    const ticketMatch = await prisma.ticket.findFirst({
                        where: { poNumber: item.poNumber, supplierId: updatedSupplierId },
                    });
                    if (ticketMatch)
                        matchedTicketId = ticketMatch.id;
                }
                if (!matchedTicketId) {
                    // Secondary match: supplier + date range (+/- 3 days) + material + qty (+/- 5%)
                    const invoiceDate = new Date(updatedInvoice.invoiceDate);
                    const minDate = new Date(invoiceDate);
                    minDate.setDate(minDate.getDate() - 3);
                    const maxDate = new Date(invoiceDate);
                    maxDate.setDate(maxDate.getDate() + 3);
                    const secondaryTicketMatch = await prisma.ticket.findFirst({
                        where: {
                            supplierId: updatedSupplierId,
                            ticketDate: { gte: minDate, lte: maxDate },
                            // fuzzy material match or just skip material for secondary match if too strict
                        }
                    });
                    if (secondaryTicketMatch) {
                        const ticketQty = Number(secondaryTicketMatch.quantity || 0);
                        const diff = Math.abs(item.quantity - ticketQty);
                        const tolerance = item.quantity * 0.05;
                        if (diff <= tolerance) {
                            matchedTicketId = secondaryTicketMatch.id;
                        }
                    }
                }
                if (!matchedTicketId)
                    flags.push(LineItemFlag.NO_TICKET);
                // --- MATCH 2: Invoice Line to Order ---
                if (item.poNumber) {
                    const orderMatch = await prisma.order.findFirst({
                        where: { poNumber: item.poNumber, supplierId: updatedSupplierId },
                    });
                    if (orderMatch) {
                        matchedOrderId = orderMatch.id;
                        const orderQty = Number(orderMatch.quantity);
                        const diff = item.quantity - orderQty;
                        const tolerance = orderQty * 0.02;
                        if (diff > tolerance) {
                            flags.push(LineItemFlag.QTY_MISMATCH);
                            qtyDiscrepancy = diff;
                        }
                    }
                    else {
                        flags.push(LineItemFlag.NO_ORDER);
                    }
                }
                else {
                    flags.push(LineItemFlag.NO_ORDER);
                }
                // --- MATCH 3: Rate Match ---
                const allRates = await prisma.negotiatedRate.findMany({
                    where: { supplierId: updatedSupplierId },
                });
                const rateMatch = allRates.find(r => stringsMatchFuzzy(r.productName, item.description));
                if (rateMatch) {
                    negotiatedRateVal = Number(rateMatch.rate);
                    const diff = item.unitPrice - negotiatedRateVal;
                    if (diff > 0.01) {
                        flags.push(LineItemFlag.RATE_MISMATCH);
                        rateDiscrepancy = diff;
                    }
                }
                else {
                    flags.push(LineItemFlag.RATE_UNKNOWN);
                }
                // --- Final Flagging ---
                let finalFlag = LineItemFlag.OK;
                if (flags.length > 1) {
                    finalFlag = LineItemFlag.MULTIPLE_FLAGS;
                }
                else if (flags.length === 1) {
                    finalFlag = flags[0];
                }
                await prisma.invoiceLineItem.create({
                    data: {
                        invoiceId,
                        lineNumber: i + 1,
                        description: item.description,
                        poNumber: item.poNumber || null,
                        quantity: item.quantity,
                        unit: 'ea',
                        unitRate: item.unitPrice,
                        lineTotal: item.totalPrice,
                        matchedOrderId,
                        matchedTicketId,
                        negotiatedRate: negotiatedRateVal,
                        rateDiscrepancy,
                        qtyDiscrepancy,
                        flag: finalFlag,
                    }
                });
            }
            if (ocrJob) {
                await prisma.ocrJob.update({
                    where: { id: ocrJob.id },
                    data: { status: OcrJobStatus.COMPLETED, finishedAt: new Date() },
                });
            }
            return updatedInvoice;
        }
        catch (error) {
            if (ocrJob) {
                await prisma.ocrJob.update({
                    where: { id: ocrJob.id },
                    data: { status: OcrJobStatus.FAILED, errorMessage: error.message, finishedAt: new Date() },
                });
            }
            await prisma.invoice.update({
                where: { id: invoiceId },
                data: { OcrJobStatus: OcrJobStatus.FAILED },
            });
            throw error;
        }
    },
    async getInvoices(filters) {
        return prisma.invoice.findMany({
            where: filters || {},
            orderBy: { receivedAt: 'desc' },
            include: {
                supplier: true,
                lineItems: true,
                verifiedBy: true,
            },
        });
    },
    async getInvoiceById(id) {
        return prisma.invoice.findUnique({
            where: { id },
            include: {
                supplier: true,
                lineItems: {
                    include: { matchedOrder: true, matchedTicket: true }
                },
                verifiedBy: true,
                ocrJobs: { orderBy: { startedAt: 'desc' } },
            },
        });
    },
    async verifyInvoice(id, userId) {
        const updated = await prisma.invoice.update({
            where: { id },
            data: {
                status: InvoiceStatus.VERIFIED,
                verifiedById: userId,
                verifiedAt: new Date(),
            },
        });
        await prisma.auditLog.create({
            data: {
                entityType: AuditEntityType.INVOICE,
                entityId: id,
                actionType: AuditActionType.INVOICE_VERIFIED,
                performedById: userId,
                details: { newStatus: InvoiceStatus.VERIFIED },
            },
        });
        return updated;
    },
    async disputeInvoice(id, userId, disputeNote) {
        const updated = await prisma.invoice.update({
            where: { id },
            data: {
                status: InvoiceStatus.DISPUTED,
                disputeNote,
                verifiedById: userId,
                verifiedAt: new Date(),
            },
        });
        await prisma.auditLog.create({
            data: {
                entityType: AuditEntityType.INVOICE,
                entityId: id,
                actionType: AuditActionType.INVOICE_DISPUTED,
                performedById: userId,
                details: { disputeNote },
            },
        });
        return updated;
    },
    async reopenInvoice(id, userId, reason) {
        const updated = await prisma.invoice.update({
            where: { id },
            data: {
                status: InvoiceStatus.PENDING_REVIEW,
                verifiedById: null,
                verifiedAt: null,
            },
        });
        await prisma.auditLog.create({
            data: {
                entityType: AuditEntityType.INVOICE,
                entityId: id,
                actionType: AuditActionType.INVOICE_REOPENED,
                performedById: userId,
                details: { reason, previousStatus: 'LOCKED' },
            },
        });
        return updated;
    }
};
//# sourceMappingURL=invoice.service.js.map