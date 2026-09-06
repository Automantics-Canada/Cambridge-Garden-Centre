import { prisma } from '../../db/prisma.js';
import { saveTicketImage } from '../../services/fileStorage.js';
import { extractTicketFromUrl } from '../../services/extraction/extraction.service.js';
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


export interface TicketFilters {
  status?: TicketStatus;
  supplierId?: string;
  source?: TicketSource;
  startDate?: Date;
  endDate?: Date;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Single source of truth for ticket filtering.
 *
 * The list query and the pagination count must apply identical predicates or
 * the reported total will not match the rows returned. This was previously
 * duplicated verbatim in both functions, which is exactly how those two drift.
 */
export function buildTicketWhere(filters?: TicketFilters) {
  const where: any = {};

  if (filters?.status) where.status = filters.status;
  if (filters?.supplierId) where.supplierId = filters.supplierId;
  if (filters?.source) where.source = filters.source;

  if (filters?.startDate || filters?.endDate) {
    where.receivedAt = {};
    if (filters.startDate) where.receivedAt.gte = filters.startDate;
    if (filters.endDate) where.receivedAt.lte = filters.endDate;
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

  return where;
}

/**
 * Columns the tickets table actually renders.
 *
 * The previous projection pulled whole related rows â€” supplier, driver, linked
 * order, and every order match with its complete order attached â€” for all 50
 * rows on the page. The review modal refetches the full ticket by id when it
 * opens, so none of that relational payload was ever displayed in the list.
 *
 * GET /api/tickets measured ~6s in production before this change. That number
 * covers the endpoint as a whole; how much of it this projection accounted for
 * has not been isolated.
 */
const TICKET_LIST_SELECT = {
  id: true,
  ticketNumber: true,
  source: true,
  supplierId: true,
  supplierName: true,
  poNumber: true,
  material: true,
  quantity: true,
  unit: true,
  imageUrl: true,
  thumbnailUrl: true,
  status: true,
  receivedAt: true,
  supplier: { select: { id: true, name: true } },
} as const;

export const TicketService = {
  /**
   * Ticket arrives via WhatsApp: save file, create Ticket, queue OCR.
   */
  async ingestWhatsappTicket(params: {
    buffer: Buffer;
    originalName: string;
    fromPhone: string;
  }) {
    const { imageUrl, thumbnailUrl } = await saveTicketImage(params.buffer, params.originalName);

    const driverId = await findDriverIdByPhone(params.fromPhone);

    const ticket = await prisma.ticket.create({
      data: {
        source: TicketSource.WHATSAPP,
        imageUrl,
        thumbnailUrl,
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
        provider: OcrProvider.OPENAI,
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
    const { imageUrl, thumbnailUrl } = await saveTicketImage(params.buffer, params.originalName);

    const supplierId = await findSupplierIdByEmail(params.fromEmail);

    const ticket = await prisma.ticket.create({
      data: {
        source: TicketSource.EMAIL,
        imageUrl,
        thumbnailUrl,
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
        provider: OcrProvider.OPENAI,
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
  }, waitOcr: boolean = false) {
    const { imageUrl, thumbnailUrl } = await saveTicketImage(params.buffer, params.originalName);

    let ticket = await prisma.ticket.create({
      data: {
        source: TicketSource.MANUAL,
        imageUrl,
        thumbnailUrl,
        ocrRawText: '',
        ocrConfidence: 0,
        status: TicketStatus.UNLINKED,
        receivedAt: new Date(),
      },
    });

    const ocrJob = await prisma.ocrJob.create({
      data: {
        type: OcrJobType.TICKET,
        provider: OcrProvider.OPENAI,
        status: OcrJobStatus.PENDING,
        ticketId: ticket.id,
      },
    });

    if (waitOcr) {
      ticket = await TicketService.processTicketOcr(ticket.id);
    } else {
      triggerOcrProcessing(ocrJob.id);
    }

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
      // The fields below arrive schema-validated: material and unit are a
      // string or null, quantity is a finite number or null. Forty lines of
      // coercion used to stand here, flattening arrays and digging values out
      // of objects, because the old pipeline asked a model for JSON in prose
      // and re-parsed whatever came back. That cannot happen now â€” a response
      // that does not fit the schema fails the job instead of arriving as junk.
      const extracted = await extractTicketFromUrl(ticket.imageUrl);

      const finalPoNumber = extracted.poNumber || ticket.poNumber;
      const isValidPo = !!(finalPoNumber && /^\d{6}$/.test(finalPoNumber));

      let linkedOrderId: string | null = ticket.linkedOrderId;
      let ticketStatus: TicketStatus = ticket.status;
      let linkMethod: string | null = ticket.linkMethod;

      // ONLY automatically link if the ticket is uploaded by a driver (has driverId)
      if (ticketStatus === TicketStatus.UNLINKED && ticket.driverId) {
        let matchedOrder = null;
        let matchMethod = 'AUTO_PO';

        if (isValidPo) {
          // 1. Try to find the order by PO number that was assigned to this driver
          const matchingOrders = await prisma.order.findMany({
            where: {
              poNumber: finalPoNumber as string,
              driverId: ticket.driverId,
            },
          });

          if (matchingOrders.length === 1) {
            matchedOrder = matchingOrders[0];
            matchMethod = 'AUTO_PO';
          }
        }

        // There is deliberately no fallback here.
        //
        // This used to link the ticket to whichever delivery happened to be
        // first in the driver's queue when the PO did not match, recorded as
        // AUTO_DRIVER_ASSIGNED. That is a guess, and it was written to the
        // database indistinguishably from a real PO match â€” so a ticket for one
        // customer could end up as evidence against another customer's invoice,
        // with nothing on screen to say it had been guessed.
        //
        // An unmatched ticket now stays UNLINKED and surfaces on the
        // verification desk, which exists precisely for a human to resolve this.

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
      } else {
        if (!ticket.driverId) {
          console.log(`[TicketService] Ticket ${ticketId} was not uploaded by a driver. Skipping auto-linking.`);
        } else if (ticketStatus !== TicketStatus.UNLINKED) {
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
          // There is no intermediate OCR text layer any more â€” the model reads
          // the document itself â€” so what is kept here is the reading, which is
          // what a person on the verification desk actually needs to see.
          ocrRawText: JSON.stringify(extracted),
          ocrConfidence: extracted.confidence,
          supplierId: updatedSupplierId,
          supplierName: extracted.supplierName || ticket.supplierName,
          material: extracted.material || ticket.material,
          quantity: extracted.quantity !== null ? extracted.quantity : ticket.quantity,
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
  async getTickets(filters?: TicketFilters) {
    const where = buildTicketWhere(filters);

    const page = filters?.page ? Number(filters.page) : undefined;
    const limit = filters?.limit ? Number(filters.limit) : undefined;
    const skip = page && limit ? (page - 1) * limit : undefined;
    const take = limit ? limit : undefined;

    const queryOptions: any = {
      where,
      orderBy: { receivedAt: 'desc' },
      select: TICKET_LIST_SELECT,
    };

    if (skip !== undefined) queryOptions.skip = skip;
    if (take !== undefined) queryOptions.take = take;

    return prisma.ticket.findMany(queryOptions);
  },

  async countTickets(filters?: TicketFilters) {
    return prisma.ticket.count({ where: buildTicketWhere(filters) });
  },


  async getTicketStats() {
    // `stuckDocumentCount` is documents whose OCR exhausted its retries. Before
    // this existed, a permanently failed job was indistinguishable from one not
    // processed yet â€” the ticket simply never gained its fields and nothing said
    // why. Surfaced next to the unlinked count so it is seen the same day.
    const [unlinkedCount, stuckDocumentCount] = await Promise.all([
      prisma.ticket.count({ where: { status: TicketStatus.UNLINKED } }),
      prisma.ocrJob.count({ where: { status: OcrJobStatus.FAILED } }),
    ]);

    return { unlinkedCount, stuckDocumentCount };
  },

  /**
   * Get a single ticket by ID
   */
  async getTicketById(id: string) {
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
