import { prisma } from '../../db/prisma.js';
import { saveTicketImage } from '../../services/fileStorage.js';
import { extractTextFromLocalImage } from '../../services/ocr.service.js';
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
        provider: OcrProvider.GOOGLE_VISION, // or whatever default you use
        status: OcrJobStatus.PENDING,
        ticketId: ticket.id,
      },
    });

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
        provider: OcrProvider.GOOGLE_VISION,
        status: OcrJobStatus.PENDING,
        ticketId: ticket.id,
      },
    });

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
      
      const updatedTicket = await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          ocrRawText: extracted.rawText,
          ocrConfidence: 0.9,
          material: extracted.material || ticket.material,
          quantity: extracted.quantity || ticket.quantity,
          poNumber: extracted.poNumber || ticket.poNumber,
          ticketNumber: extracted.ticketNumber || ticket.ticketNumber,
          ticketDate: extracted.ticketDate || ticket.ticketDate,
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
   * Get all tickets with optional filtering
   */
  async getTickets(filters?: { status?: TicketStatus; supplierId?: string }) {
    return prisma.ticket.findMany({
      where: filters || {},
      orderBy: { receivedAt: 'desc' },
      include: { supplier: true, driver: true },
    });
  },

  /**
   * Get a single ticket by ID
   */
  async getTicketById(id: string) {
    return prisma.ticket.findUnique({
      where: { id },
      include: { supplier: true, driver: true, ocrJobs: true },
    });
  },

  /**
   * Update a ticket
   */
  async updateTicket(id: string, data: any) {
    return prisma.ticket.update({
      where: { id },
      data,
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