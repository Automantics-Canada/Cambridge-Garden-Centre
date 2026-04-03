import { prisma } from '../../db/prisma.js';
import { saveInvoiceImage } from '../../services/fileStorage.js';
import { extractExpenseFromLocalImage } from '../../services/invoiceOcr.service.js';
import { InvoiceStatus, SenderType, OcrJobType, OcrProvider, OcrJobStatus, LineItemFlag, AuditEntityType, AuditActionType, } from '@prisma/client';
async function findSupplierByName(name) {
    if (!name)
        return null;
    // very naive matching for mockup
    const supplier = await prisma.supplier.findFirst({
        where: {
            name: { contains: name, mode: 'insensitive' },
        },
    });
    return supplier;
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
            // In a real system, you might place it in a queue or require manual mapping.
            // For this mock, we'll assign to the first supplier just so it doesn't fail,
            // or create a dummy unknown supplier.
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
                totalAmount: 0, // to be updated by OCR
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
            // Try a better supplier match if extracted
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
            // Clear existing line items if any
            await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
            for (let i = 0; i < extracted.lineItems.length; i++) {
                const item = extracted.lineItems[i];
                // Matching Engine Logic
                // We'll perform generic matching here: 
                // 1. Try to find an Order for this supplier with the product
                // 2. Try to find a NegotiatedRate
                // 3. Flag accordingly
                let matchedOrderId = null;
                let matchedTicketId = null;
                let negotiatedRateVal = null;
                let flag = LineItemFlag.OK;
                let rateDiscrepancy = null;
                // Try Order Match
                const orderMatch = await prisma.order.findFirst({
                    where: { supplierId: updatedSupplierId },
                    orderBy: { orderDate: 'desc' }
                });
                if (orderMatch)
                    matchedOrderId = orderMatch.id;
                else
                    flag = LineItemFlag.NO_ORDER;
                if (!item)
                    continue;
                // Try Negotiated Rate
                const rateMatch = await prisma.negotiatedRate.findFirst({
                    where: { supplierId: updatedSupplierId, productName: { contains: item.description, mode: 'insensitive' } }
                });
                if (rateMatch) {
                    negotiatedRateVal = Number(rateMatch.rate);
                    if (Math.abs(item.unitPrice - negotiatedRateVal) > 0.01) {
                        flag = flag === LineItemFlag.NO_ORDER ? LineItemFlag.MULTIPLE_FLAGS : LineItemFlag.RATE_MISMATCH;
                        rateDiscrepancy = item.unitPrice - negotiatedRateVal;
                    }
                }
                else {
                    flag = flag === LineItemFlag.NO_ORDER ? LineItemFlag.MULTIPLE_FLAGS : LineItemFlag.RATE_UNKNOWN;
                }
                await prisma.invoiceLineItem.create({
                    data: {
                        invoiceId,
                        lineNumber: i + 1,
                        description: item.description,
                        quantity: item.quantity,
                        unit: 'ea', // fallback or try to extract
                        unitRate: item.unitPrice,
                        lineTotal: item.totalPrice,
                        matchedOrderId,
                        matchedTicketId,
                        negotiatedRate: negotiatedRateVal,
                        rateDiscrepancy,
                        flag,
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
                ocrJobs: true,
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
                verifiedById: userId, // we can reuse this field for whoever actioned it
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
    }
};
//# sourceMappingURL=invoice.service.js.map