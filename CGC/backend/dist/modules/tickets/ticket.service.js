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
    /**
     * Ticket uploaded manually by admin: save file, create Ticket, queue OCR.
     */
    async ingestManualTicket(params, waitOcr = false) {
        const imageUrl = await saveTicketImage(params.buffer, params.originalName);
        let ticket = await prisma.ticket.create({
            data: {
                source: TicketSource.MANUAL,
                imageUrl,
                ocrRawText: '',
                ocrConfidence: 0,
                status: TicketStatus.UNLINKED,
                receivedAt: new Date(),
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
        if (waitOcr) {
            ticket = await TicketService.processTicketOcr(ticket.id);
        }
        else {
            triggerOcrProcessing(ocrJob.id);
        }
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
            // Sanitize extracted values
            let sanitizedMaterial = null;
            if (extracted.material) {
                if (Array.isArray(extracted.material)) {
                    sanitizedMaterial = extracted.material.map((m) => {
                        if (typeof m === 'object' && m !== null) {
                            return m.name || m.description || JSON.stringify(m);
                        }
                        return String(m);
                    }).join(', ');
                }
                else if (typeof extracted.material === 'object') {
                    const mObj = extracted.material;
                    sanitizedMaterial = mObj.name || mObj.description || JSON.stringify(mObj);
                }
                else {
                    sanitizedMaterial = String(extracted.material);
                }
            }
            let sanitizedQuantity = null;
            if (extracted.quantity !== undefined && extracted.quantity !== null) {
                if (Array.isArray(extracted.quantity)) {
                    const nums = extracted.quantity.map((q) => parseFloat(String(q))).filter((n) => !isNaN(n));
                    sanitizedQuantity = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
                }
                else if (typeof extracted.quantity === 'object') {
                    const qObj = extracted.quantity;
                    const val = parseFloat(String(qObj.value || qObj.amount || qObj.quantity));
                    sanitizedQuantity = isNaN(val) ? null : val;
                }
                else {
                    const val = parseFloat(String(extracted.quantity));
                    sanitizedQuantity = isNaN(val) ? null : val;
                }
            }
            let sanitizedUnit = null;
            if (extracted.unit) {
                if (Array.isArray(extracted.unit)) {
                    sanitizedUnit = extracted.unit.map((u) => typeof u === 'object' ? (u.name || JSON.stringify(u)) : String(u)).join(', ');
                }
                else if (typeof extracted.unit === 'object') {
                    const uObj = extracted.unit;
                    sanitizedUnit = uObj.name || uObj.unit || JSON.stringify(uObj);
                }
                else {
                    sanitizedUnit = String(extracted.unit);
                }
            }
            const finalPoNumber = extracted.poNumber || ticket.poNumber;
            const isValidPo = !!(finalPoNumber && /^\d{6}$/.test(finalPoNumber));
            let linkedOrderId = ticket.linkedOrderId;
            let ticketStatus = ticket.status;
            let linkMethod = ticket.linkMethod;
            // ONLY automatically link if the ticket is uploaded by a driver (has driverId)
            if (ticketStatus === TicketStatus.UNLINKED && ticket.driverId) {
                let matchedOrder = null;
                let matchMethod = 'AUTO_PO';
                if (isValidPo) {
                    // 1. Try to find the order by PO number that was assigned to this driver
                    const matchingOrders = await prisma.order.findMany({
                        where: {
                            poNumber: finalPoNumber,
                            driverId: ticket.driverId,
                        },
                    });
                    if (matchingOrders.length === 1) {
                        matchedOrder = matchingOrders[0];
                        matchMethod = 'AUTO_PO';
                    }
                }
                // 2. Fallback: If no PO match, look for an active delivery order assigned to this driver
                if (!matchedOrder) {
                    const activeDeliveries = await prisma.delivery.findMany({
                        where: {
                            driverId: ticket.driverId,
                            status: { notIn: ['DELIVERED', 'CANCELLED'] },
                        },
                        orderBy: { priority: 'asc' },
                        include: { order: true },
                    });
                    if (activeDeliveries.length > 0) {
                        matchedOrder = activeDeliveries[0].order;
                        matchMethod = 'AUTO_DRIVER_ASSIGNED';
                    }
                }
                if (matchedOrder) {
                    await prisma.ticketOrderMatch.upsert({
                        where: {
                            ticketId_orderId: {
                                ticketId: ticketId,
                                orderId: matchedOrder.id,
                            },
                        },
                        update: {},
                        create: {
                            ticketId: ticketId,
                            orderId: matchedOrder.id,
                            matchMethod: matchMethod,
                        },
                    });
                    linkedOrderId = matchedOrder.id;
                    ticketStatus = TicketStatus.LINKED;
                    linkMethod = 'AUTO';
                    console.log(`[TicketService] Automatically linked driver ticket ${ticketId} to assigned order ${matchedOrder.id} (method: ${matchMethod})`);
                }
            }
            else {
                if (!ticket.driverId) {
                    console.log(`[TicketService] Ticket ${ticketId} was not uploaded by a driver. Skipping auto-linking.`);
                }
                else if (ticketStatus !== TicketStatus.UNLINKED) {
                    console.log(`[TicketService] Ticket ${ticketId} is already linked. Skipping auto-linking.`);
                }
            }
            // Find or create supplier if extracted
            let updatedSupplierId = ticket.supplierId;
            if (extracted.supplierName) {
                const { SupplierService } = await import('../supplier/supplier.service.js');
                const foundSupplier = await SupplierService.findOrCreateSupplier(extracted.supplierName);
                if (foundSupplier) {
                    updatedSupplierId = foundSupplier.id;
                }
            }
            const updatedTicket = await prisma.ticket.update({
                where: { id: ticketId },
                data: {
                    ocrRawText: extracted.rawText,
                    ocrConfidence: extracted.ocrConfidence,
                    supplierId: updatedSupplierId,
                    supplierName: extracted.supplierName || ticket.supplierName,
                    material: sanitizedMaterial || ticket.material,
                    quantity: sanitizedQuantity !== null ? sanitizedQuantity : ticket.quantity,
                    unit: sanitizedUnit || ticket.unit,
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
     * Get all tickets with optional filtering and pagination
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
        if (filters?.search && filters.search.trim()) {
            const s = filters.search.trim();
            where.OR = [
                { ticketNumber: { contains: s, mode: 'insensitive' } },
                { poNumber: { contains: s, mode: 'insensitive' } },
                { material: { contains: s, mode: 'insensitive' } },
                { supplierName: { contains: s, mode: 'insensitive' } },
                { supplier: { name: { contains: s, mode: 'insensitive' } } },
            ];
        }
        const page = filters?.page ? Number(filters.page) : undefined;
        const limit = filters?.limit ? Number(filters.limit) : undefined;
        const skip = page && limit ? (page - 1) * limit : undefined;
        const take = limit ? limit : undefined;
        const queryOptions = {
            where,
            orderBy: { receivedAt: 'desc' },
            select: {
                id: true,
                ticketNumber: true,
                source: true,
                supplierId: true,
                supplierName: true,
                poNumber: true,
                material: true,
                quantity: true,
                unit: true,
                rateOnTicket: true,
                ticketDate: true,
                imageUrl: true,
                ocrConfidence: true,
                linkedOrderId: true,
                linkMethod: true,
                linkedById: true,
                status: true,
                receivedAt: true,
                driverId: true,
                deliveryStatus: true,
                spruceMatched: true,
                supplier: true,
                driver: true,
                linkedOrder: true,
                orderMatches: {
                    include: {
                        order: true
                    }
                }
            }
        };
        if (skip !== undefined)
            queryOptions.skip = skip;
        if (take !== undefined)
            queryOptions.take = take;
        return prisma.ticket.findMany(queryOptions);
    },
    async countTickets(filters) {
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
        if (filters?.search && filters.search.trim()) {
            const s = filters.search.trim();
            where.OR = [
                { ticketNumber: { contains: s, mode: 'insensitive' } },
                { poNumber: { contains: s, mode: 'insensitive' } },
                { material: { contains: s, mode: 'insensitive' } },
                { supplierName: { contains: s, mode: 'insensitive' } },
                { supplier: { name: { contains: s, mode: 'insensitive' } } },
            ];
        }
        return prisma.ticket.count({ where });
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
        if (!id || id === 'undefined' || id.length < 36) {
            throw new Error('Invalid ticket ID');
        }
        return prisma.ticket.findUnique({
            where: { id },
            include: {
                supplier: true,
                driver: true,
                ocrJobs: true,
                linkedOrder: true,
                orderMatches: {
                    include: { order: true }
                }
            },
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
    async unlinkTicketFromOrder(ticketId, orderId) {
        // Delete junction record
        await prisma.ticketOrderMatch.delete({
            where: {
                ticketId_orderId: {
                    ticketId,
                    orderId,
                },
            },
        });
        // Check if there are any remaining matches
        const remainingMatches = await prisma.ticketOrderMatch.findMany({
            where: { ticketId },
            orderBy: { matchedAt: 'desc' },
        });
        if (remainingMatches.length > 0) {
            // Update legacy field to the next available match
            await prisma.ticket.update({
                where: { id: ticketId },
                data: {
                    linkedOrderId: remainingMatches[0]?.orderId || null,
                },
            });
        }
        else {
            // No matches left, reset status
            await prisma.ticket.update({
                where: { id: ticketId },
                data: {
                    linkedOrderId: null,
                    status: TicketStatus.UNLINKED,
                    linkMethod: null,
                },
            });
        }
    },
    async linkTicketToOrder(ticketId, orderId, userId) {
        // Create junction record
        await prisma.ticketOrderMatch.upsert({
            where: {
                ticketId_orderId: {
                    ticketId,
                    orderId,
                },
            },
            update: {
                matchMethod: 'MANUAL',
                createdBy: userId || null,
            },
            create: {
                ticketId,
                orderId,
                matchMethod: 'MANUAL',
                createdBy: userId || null,
            },
        });
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