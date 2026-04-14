import { prisma } from '../../db/prisma.js';
import { saveTicketImage } from '../../services/fileStorage.js';
import { extractTextFromLocalImage } from '../../services/ocr.service.js';
import { triggerOcrProcessing } from '../../services/ocrJobProcessor.js';
import { TicketSource, TicketStatus, OcrJobType, OcrJobStatus, OcrProvider, } from '@prisma/client';
async function findDriverIdByPhone(phone) {
    if (!phone)
        return null;
    const trimmed = phone.trim();
    if (!trimmed)
        return null;
    const driver = await prisma.driver.findUnique({
        where: { phone: trimmed },
    });
    return driver?.id ?? null;
}
async function findSupplierIdByEmail(fromEmail) {
    if (!fromEmail)
        return null;
    const match = fromEmail.trim().toLowerCase().match(/@(.+)$/);
    if (!match)
        return null;
    const domain = match[1];
    const supplier = await prisma.supplier.findFirst({
        where: {
            emailDomains: {
                has: domain,
            },
        },
    });
    return supplier?.id ?? null;
}
export const TicketService = {
    /**
     * Ticket arrives via WhatsApp: save file, create Ticket, queue OCR.
     */
    async ingestWhatsappTicket(params) {
        const imageUrl = await saveTicketImage(params.buffer, params.originalName);
        const driverId = await findDriverIdByPhone(params.fromPhone);
        const ticket = await prisma.ticket.create({
            data: {
                source: TicketSource.WHATSAPP,
                imageUrl,
                // required non-null fields in your model:
                ocrRawText: '',
                ocrConfidence: 0,
                status: TicketStatus.UNLINKED,
                receivedAt: new Date(),
                driverId: driverId ?? null,
                // all other fields (supplierId, poNumber, etc.) remain null for now
            },
        });
        const ocrJob = await prisma.ocrJob.create({
            data: {
                type: OcrJobType.TICKET,
                provider: OcrProvider.AWS_TEXTRACT, // or whatever default you use
                status: OcrJobStatus.PENDING,
                ticketId: ticket.id,
            },
        });
        // Automatically trigger OCR processing in the background (non-blocking)
        triggerOcrProcessing(ocrJob.id);
        return { ticket, ocrJob };
    },
    /**
     * Ticket arrives via email: save file, create Ticket, queue OCR.
     */
    async ingestEmailTicket(params) {
        const imageUrl = await saveTicketImage(params.buffer, params.originalName);
        const supplierId = await findSupplierIdByEmail(params.fromEmail);
        const ticket = await prisma.ticket.create({
            data: {
                source: TicketSource.EMAIL,
                imageUrl,
                ocrRawText: '',
                ocrConfidence: 0,
                status: TicketStatus.UNLINKED,
                receivedAt: new Date(),
                supplierId: supplierId ?? null,
            },
        });
        const ocrJob = await prisma.ocrJob.create({
            data: {
                type: OcrJobType.TICKET,
                provider: OcrProvider.AWS_TEXTRACT,
                status: OcrJobStatus.PENDING,
                ticketId: ticket.id,
            },
        });
        // Automatically trigger OCR processing in the background (non-blocking)
        triggerOcrProcessing(ocrJob.id);
        return { ticket, ocrJob };
    },
    async processTicketOcr(ticketId) {
        const ticket = await prisma.ticket.findUnique({
            where: { id: ticketId },
            include: { ocrJobs: { orderBy: { startedAt: 'desc' }, take: 1 } },
        });
        if (!ticket)
            throw new Error('Ticket not found');
        const ocrJob = ticket.ocrJobs[0];
        if (ocrJob) {
            await prisma.ocrJob.update({
                where: { id: ocrJob.id },
                data: { status: OcrJobStatus.PROCESSING, startedAt: new Date() },
            });
        }
        try {
            const extracted = await extractTextFromLocalImage(ticket.imageUrl);
            const finalPoNumber = extracted.poNumber || ticket.poNumber;
            let linkedOrderId = null;
            let ticketStatus = TicketStatus.UNLINKED;
            let linkMethod = null;
            if (finalPoNumber) {
                // Attempt to find Order by PO number
                const matchingOrders = await prisma.order.findMany({
                    where: { poNumber: finalPoNumber },
                });
                // Link automatically if exactly one match is found
                if (matchingOrders.length === 1) {
                    const matchingOrder = matchingOrders[0];
                    if (matchingOrder) {
                        linkedOrderId = matchingOrder.id;
                        ticketStatus = TicketStatus.LINKED;
                        linkMethod = 'AUTO';
                    }
                }
            }
            const updatedTicket = await prisma.ticket.update({
                where: { id: ticketId },
                data: {
                    ocrRawText: extracted.rawText,
                    ocrConfidence: extracted.ocrConfidence,
                    material: extracted.material || ticket.material,
                    quantity: extracted.quantity || ticket.quantity,
                    poNumber: finalPoNumber,
                    ticketNumber: extracted.ticketNumber || ticket.ticketNumber,
                    ticketDate: extracted.ticketDate || ticket.ticketDate,
                    linkedOrderId,
                    status: ticketStatus,
                    linkMethod,
                },
            });
            if (ocrJob) {
                await prisma.ocrJob.update({
                    where: { id: ocrJob.id },
                    data: {
                        status: OcrJobStatus.COMPLETED,
                        finishedAt: new Date(),
                        rawResponse: extracted,
                    },
                });
            }
            return updatedTicket;
        }
        catch (error) {
            if (ocrJob) {
                await prisma.ocrJob.update({
                    where: { id: ocrJob.id },
                    data: {
                        status: OcrJobStatus.FAILED,
                        finishedAt: new Date(),
                        errorMessage: error.message,
                    },
                });
            }
            throw error;
        }
    },
    /**
     * Get all tickets with optional filtering
     */
    async getTickets(filters) {
        const where = {};
        if (filters?.status)
            where.status = filters.status;
        if (filters?.supplierId)
            where.supplierId = filters.supplierId;
        if (filters?.source)
            where.source = filters.source;
        if (filters?.startDate || filters?.endDate) {
            where.receivedAt = {};
            if (filters.startDate)
                where.receivedAt.gte = new Date(filters.startDate);
            if (filters.endDate)
                where.receivedAt.lte = new Date(filters.endDate);
        }
        if (filters?.search) {
            where.OR = [
                { ticketNumber: { contains: filters.search, mode: 'insensitive' } },
                { poNumber: { contains: filters.search, mode: 'insensitive' } },
                { material: { contains: filters.search, mode: 'insensitive' } },
            ];
        }
        return prisma.ticket.findMany({
            where,
            orderBy: { receivedAt: 'desc' },
            include: { supplier: true, driver: true, linkedOrder: true },
        });
    },
    async getTicketStats() {
        const unlinkedCount = await prisma.ticket.count({
            where: { status: TicketStatus.UNLINKED },
        });
        return { unlinkedCount };
    },
    /**
     * Get a single ticket by ID
     */
    async getTicketById(id) {
        return prisma.ticket.findUnique({
            where: { id },
            include: { supplier: true, driver: true, ocrJobs: true, linkedOrder: true },
        });
    },
    /**
     * Update a ticket
     */
    async updateTicket(id, data) {
        // If we're updating linkedOrderId manually, set linkMethod and status
        if (data.linkedOrderId && data.linkedOrderId !== undefined) {
            data.status = TicketStatus.LINKED;
            data.linkMethod = 'MANUAL';
        }
        else if (data.linkedOrderId === null) {
            data.status = TicketStatus.UNLINKED;
            data.linkMethod = null;
        }
        return prisma.ticket.update({
            where: { id },
            data,
        });
    },
    async linkTicketToOrder(ticketId, orderId, userId) {
        return prisma.ticket.update({
            where: { id: ticketId },
            data: {
                linkedOrderId: orderId,
                status: TicketStatus.LINKED,
                linkMethod: 'MANUAL',
                linkedById: userId || null,
            },
        });
    },
    /**
     * Delete a ticket
     */
    async deleteTicket(id) {
        return prisma.ticket.delete({
            where: { id },
        });
    },
};
//# sourceMappingURL=ticket.service.js.map