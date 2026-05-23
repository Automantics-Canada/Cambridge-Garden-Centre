import { prisma } from '../../db/prisma.js';
import { saveTicketImage } from '../../services/fileStorage.js';
import { extractTextFromLocalImage } from '../../services/ocr.service.js';
import { triggerOcrProcessing } from '../../services/ocrJobProcessor.js';
import {
  TicketSource,
  TicketStatus,
  OcrJobType,
  OcrJobStatus,
  OcrProvider,
} from '@prisma/client';


async function findDriverIdByPhone(phone: string | undefined | null) {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;

  const driver = await prisma.driver.findUnique({
    where: { phone: trimmed },
  });

  return driver?.id ?? null;
}

async function findSupplierIdByEmail(fromEmail: string | undefined | null) {
  if (!fromEmail) return null;
  const match = fromEmail.trim().toLowerCase().match(/@(.+)$/);
  if (!match) return null;
  const domain = match[1] as string;

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
  async ingestWhatsappTicket(params: {
    buffer: Buffer;
    originalName: string;
    fromPhone: string;
  }) {
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
  async ingestEmailTicket(params: {
    buffer: Buffer;
    originalName: string;
    fromEmail: string;
  }) {
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
  async ingestManualTicket(params: {
    buffer: Buffer;
    originalName: string;
  }) {
    const imageUrl = await saveTicketImage(params.buffer, params.originalName);

    const ticket = await prisma.ticket.create({
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

    triggerOcrProcessing(ocrJob.id);

    return { ticket, ocrJob };
  },

  async processTicketOcr(ticketId: string) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { ocrJobs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    if (!ticket) throw new Error('Ticket not found');

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
      const isValidPo = !!(finalPoNumber && /^\d{6}$/.test(finalPoNumber));

      let linkedOrderId: string | null = null;
      let ticketStatus: TicketStatus = TicketStatus.UNLINKED;
      let linkMethod: string | null = null;

      if (isValidPo) {
        // Attempt to find Order by PO number
        const matchingOrders = await prisma.order.findMany({
          where: { poNumber: finalPoNumber as string },
        });

        // ONLY link automatically if there is exactly ONE order with that PO number
        if (matchingOrders.length === 1) {
          const order = matchingOrders[0]!;
          await prisma.ticketOrderMatch.upsert({
            where: {
              ticketId_orderId: {
                ticketId: ticketId,
                orderId: order.id,
              },
            },
            update: {},
            create: {
              ticketId: ticketId,
              orderId: order.id,
              matchMethod: 'AUTO_PO',
            },
          });
          
          linkedOrderId = order.id;
          ticketStatus = TicketStatus.LINKED;
          linkMethod = 'AUTO';
          console.log(`[TicketService] Automatically linked ticket ${ticketId} to single matching order ${order.id} (PO: ${finalPoNumber})`);
        } else if (matchingOrders.length > 1) {
          console.log(`[TicketService] Found ${matchingOrders.length} orders for PO ${finalPoNumber}. Cleaning up existing auto-links.`);
          
          // Cleanup any auto-matches that might have been created during incremental import
          await prisma.ticketOrderMatch.deleteMany({
            where: {
              ticketId: ticketId,
              matchMethod: { in: ['AUTO_PO', 'AUTO_FALLBACK'] }
            }
          });
          
          linkedOrderId = null;
          ticketStatus = TicketStatus.UNLINKED;
          linkMethod = null;
        }
      } else if (finalPoNumber) {
        console.log(`[TicketService] Extracted PO "${finalPoNumber}" is not 6 digits. Skipping auto-link.`);
      }

      // Find supplier if extracted
      let updatedSupplierId = ticket.supplierId;
      if (extracted.supplierName) {
        const foundSupplier = await prisma.supplier.findFirst({
          where: {
            name: { contains: extracted.supplierName, mode: 'insensitive' },
          },
        });
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
          material: extracted.material || ticket.material,
          quantity: extracted.quantity || ticket.quantity,
          unit: extracted.unit || ticket.unit,
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
            rawResponse: extracted as any,
          },
        });
      }

      return updatedTicket;
    } catch (error: any) {
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
  async getTickets(filters?: {
    status?: TicketStatus;
    supplierId?: string;
    source?: TicketSource;
    startDate?: string;
    endDate?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const where: any = {};

    if (filters?.status) where.status = filters.status;
    if (filters?.supplierId) where.supplierId = filters.supplierId;
    if (filters?.source) where.source = filters.source;

    if (filters?.startDate || filters?.endDate) {
      where.receivedAt = {};
      if (filters.startDate) where.receivedAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.receivedAt.lte = new Date(filters.endDate);
    }

    if (filters?.search) {
      where.OR = [
        { ticketNumber: { contains: filters.search, mode: 'insensitive' } },
        { poNumber: { contains: filters.search, mode: 'insensitive' } },
        { material: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const page = filters?.page ? Number(filters.page) : undefined;
    const limit = filters?.limit ? Number(filters.limit) : undefined;
    const skip = page && limit ? (page - 1) * limit : undefined;
    const take = limit ? limit : undefined;

    const queryOptions: any = {
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

    if (skip !== undefined) queryOptions.skip = skip;
    if (take !== undefined) queryOptions.take = take;

    return prisma.ticket.findMany(queryOptions);
  },

  async countTickets(filters?: {
    status?: TicketStatus;
    supplierId?: string;
    source?: TicketSource;
    startDate?: string;
    endDate?: string;
    search?: string;
  }) {
    const where: any = {};

    if (filters?.status) where.status = filters.status;
    if (filters?.supplierId) where.supplierId = filters.supplierId;
    if (filters?.source) where.source = filters.source;

    if (filters?.startDate || filters?.endDate) {
      where.receivedAt = {};
      if (filters.startDate) where.receivedAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.receivedAt.lte = new Date(filters.endDate);
    }

    if (filters?.search) {
      where.OR = [
        { ticketNumber: { contains: filters.search, mode: 'insensitive' } },
        { poNumber: { contains: filters.search, mode: 'insensitive' } },
        { material: { contains: filters.search, mode: 'insensitive' } },
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
  async getTicketById(id: string) {
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
  async updateTicket(id: string, data: any) {
    // If we're updating linkedOrderId manually, set linkMethod and status
    if (data.linkedOrderId && data.linkedOrderId !== undefined) {
      data.status = TicketStatus.LINKED;
      data.linkMethod = 'MANUAL';
    } else if (data.linkedOrderId === null) {
      data.status = TicketStatus.UNLINKED;
      data.linkMethod = null;
    }

    return prisma.ticket.update({
      where: { id },
      data,
    });
  },

  async unlinkTicketFromOrder(ticketId: string, orderId: string) {
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
    } else {
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

  async linkTicketToOrder(ticketId: string, orderId: string, userId?: string) {
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
  async deleteTicket(id: string) {
    return prisma.ticket.delete({
      where: { id },
    });
  },
};
