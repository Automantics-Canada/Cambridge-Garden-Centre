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
 * Makes a search term match only itself.
 *
 * Prisma's `contains` wraps the value in `%` and passes it to LIKE unescaped, so
 * the term's own `%` and `_` acted as wildcards: searching "%" returned every
 * ticket with any text on it. Backslash is Postgres's LIKE escape character.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/**
 * A ticket or PO number reduced to lower-case letters and digits.
 *
 * People type a number the way the paper prints it and the extraction stores it
 * the way it read it, so "T88213", "#t 88213" and "T-88213" must all find the
 * same ticket. Mirrors the trigger that fills `Ticket.numberSearchKey` in
 * migration 20260915120000_ticket_number_search_key; change both or neither.
 */
export function numberSearchKey(term: string): string {
  return term.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
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
    const term = escapeLikePattern(filters.search.trim());
    const key = numberSearchKey(filters.search);
    where.OR = [
      { ticketNumber: { contains: term, mode: 'insensitive' } },
      { poNumber: { contains: term, mode: 'insensitive' } },
      { material: { contains: term, mode: 'insensitive' } },
      { supplierName: { contains: term, mode: 'insensitive' } },
      { supplier: { name: { contains: term, mode: 'insensitive' } } },
      // A term of only punctuation has no key. Searching the empty key would
      // match every ticket, so it searches the literal fields alone.
      ...(key ? [{ numberSearchKey: { contains: key } }] : []),
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

      // Nothing here links the ticket any more.
      //
      // This used to link a ticket to an order on PO plus driverId alone, and
      // only for tickets a driver had uploaded. It checked no supplier, no
      // product and no quantity, it wrote the link before the engine had seen
      // the ticket at all, and a ticket that arrived by email, WhatsApp or a
      // manual upload was never linked however cleanly it matched. The fields
      // below are written first; `matchTicketById` then decides and, when the
      // verdict is MATCHED, writes the link itself.

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

      // Decide whether this delivery is backed by an order, now that the
      // ticket's own fields have been written. Matching is advisory — it
      // records a verdict and its evidence for the desk — so a failure here
      // must not undo a successful extraction.
      try {
        const { matchTicketById, recomputeInvoiceLinesSafely } = await import(
          '../matching/matching.service.js'
        );
        await matchTicketById(ticketId);

        // A load that has just been read changes what the invoice lines on its
        // PO are covered by, and nothing else would ever look at them again: an
        // invoice that arrived before its tickets stayed "no delivery ticket
        // accounts for this line" permanently.
        if (updatedTicket.poNumber) {
          await recomputeInvoiceLinesSafely(
            [updatedTicket.poNumber],
            `ticket ${ticketId} read`
          );
        }
      } catch (matchError) {
        console.error(`[Matching] Could not evaluate ticket ${ticketId}:`, matchError);
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
