import { prisma } from '../../db/prisma.js';
import { saveTicketImage } from '../../services/fileStorage.js';
import { extractTicketDocument } from '../../services/ocr.service.js';
import {
  buildTicketProvenance,
  summariseReviewReasons,
} from '../../services/documentExtraction/mergeExtraction.js';
import { EXTRACTION_PROVIDER } from '../../services/documentExtraction/types.js';
import type {
  ExtractedField,
  ReviewIssue,
} from '../../services/documentExtraction/types.js';
import { isoDateToUtcDate } from '../../services/documentExtraction/validation.js';
import { triggerOcrProcessing } from '../../services/ocrJobProcessor.js';
import {
  TicketSource,
  TicketStatus,
  OcrJobType,
  OcrJobStatus,
  OcrProvider,
} from '@prisma/client';


/**
 * The value of a field, but only if it validated.
 *
 * Every write below is `validValue(field) ?? whateverIsAlreadyThere`. Reading a
 * field's `.value` directly would pick up a value that failed validation, which
 * is exactly the class of bug this layer exists to prevent.
 */
function validValue<T>(field: ExtractedField<T>): T | null {
  return field.state === 'VALID' ? field.value : null;
}

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
 * The previous projection pulled whole related rows — supplier, driver, linked
 * order, and every order match with its complete order attached — for all 50
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
        provider: OcrProvider.AWS_TEXTRACT,
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

  /**
   * Read a delivery ticket and record what could be established.
   *
   * Two rules govern what this is allowed to write.
   *
   * A field is only written when it validated. Previously the extracted values
   * arrived untyped and were pushed through a stack of sanitisers that coped
   * with a model returning an array where a number belonged, or an object where
   * a string belonged, by flattening whatever it got into something the column
   * would accept. That guaranteed a write; it did not produce a fact.
   *
   * And the supplier is found, never created. `findOrCreateSupplier` accepted a
   * 0.75 string similarity as a match and invented a supplier when nothing came
   * close, so a misread letterhead either attached the delivery to whichever
   * company was spelled most like the misreading, or spawned a duplicate. Both
   * are silent and both corrupt the supplier records that invoice matching and
   * the rate tables are built on.
   */
  async processTicketOcr(ticketId: string, claimedJobId?: string) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        ocrJobs: {
          ...(claimedJobId ? { where: { id: claimedJobId } } : {}),
          orderBy: { startedAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!ticket) throw new Error('Ticket not found');

    const ocrJob = ticket.ocrJobs[0];
    if (!ocrJob) throw new Error('No OCR job found for ticket');

    if (claimedJobId) {
      if (ocrJob.status !== OcrJobStatus.PROCESSING) {
        return prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
      }
    } else {
      const now = new Date();
      const claimed = await prisma.ocrJob.updateMany({
        where: {
          id: ocrJob.id,
          status: OcrJobStatus.PENDING,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        data: {
          status: OcrJobStatus.PROCESSING,
          startedAt: now,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        return prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
      }
    }

    try {
      const outcome = await extractTicketDocument({
        imageUrl: ticket.imageUrl,
        jobId: ocrJob.id,
      });

      const fields = outcome.fields;
      const issues: ReviewIssue[] = [...outcome.issues];

      // --- Supplier: exact resolution only ---
      const { SupplierService } = await import('../supplier/supplier.service.js');
      const resolution = await SupplierService.resolveSupplierForOcr(fields.supplierName.value);

      if (!resolution.supplier) {
        issues.push({
          field: 'supplierName',
          code: 'UNRESOLVED_SUPPLIER',
          message: resolution.reason ?? 'Supplier could not be matched to a recorded supplier',
        });
      }

      // An unresolved supplier leaves whatever was already on the ticket — which
      // for an email-ingested ticket is the sender's domain match, and for a
      // driver upload is usually nothing.
      const supplierId = resolution.supplier?.id ?? ticket.supplierId;

      // --- PO and auto-link ---
      // Unchanged, and deliberately so: an exact six-digit PO that resolves to
      // exactly one order assigned to this driver. There is no fallback to "the
      // first delivery in the driver's queue" — that was a guess written to the
      // database indistinguishably from a real match, so a ticket for one
      // customer could end up as evidence against another customer's invoice.
      const extractedPo = fields.poNumber.state === 'VALID' ? (fields.poNumber.value as string) : null;
      const finalPoNumber = extractedPo ?? ticket.poNumber;
      const isValidPo = Boolean(finalPoNumber && /^\d{6}$/.test(finalPoNumber));

      let linkedOrderId: string | null = ticket.linkedOrderId;
      let ticketStatus: TicketStatus = ticket.status;
      let linkMethod: string | null = ticket.linkMethod;
      let matchedOrderId: string | null = null;

      if (ticketStatus === TicketStatus.UNLINKED && ticket.driverId && isValidPo) {
        const matchingOrders = await prisma.order.findMany({
          where: { poNumber: finalPoNumber as string, driverId: ticket.driverId },
          select: { id: true },
        });

        // Exactly one, or none. An ambiguous match stays unlinked and surfaces
        // on the verification desk, which exists precisely for a person to
        // resolve this.
        if (matchingOrders.length === 1) {
          matchedOrderId = (matchingOrders[0] as { id: string }).id;
          linkedOrderId = matchedOrderId;
          ticketStatus = TicketStatus.LINKED;
          linkMethod = 'AUTO';
        } else if (matchingOrders.length > 1) {
          issues.push({
            field: 'poNumber',
            code: 'INVALID_FIELD',
            message: `PO ${finalPoNumber} matches ${matchingOrders.length} orders for this driver; link it by hand`,
          });
        }
      }

      const complete = issues.length === 0;
      const provenance = {
        ...buildTicketProvenance({ ...outcome, issues, complete }),
        supplierMatch: { method: resolution.method, suggestion: resolution.suggestion },
        autoLink: {
          linked: complete && matchedOrderId !== null,
          method: complete && matchedOrderId ? 'AUTO_PO' : null,
        },
      };
      const reviewReasons = summariseReviewReasons(issues);

      // --- Write ---
      // Only validated fields are written, and each one falls back to what is
      // already on the ticket rather than to a placeholder. A field that could
      // not be read leaves the existing value — including a value a person has
      // already corrected by hand — untouched.
      const updatedTicket = await prisma.$transaction(
        async tx => {
          if (complete && matchedOrderId) {
            await tx.ticketOrderMatch.upsert({
              where: { ticketId_orderId: { ticketId, orderId: matchedOrderId } },
              update: {},
              create: { ticketId, orderId: matchedOrderId, matchMethod: 'AUTO_PO' },
            });
          }

          const written = await tx.ticket.update({
            where: { id: ticketId },
            data: {
              ocrRawText: outcome.ocrText,
              ocrConfidence: outcome.ocrConfidence,
              // Candidate fields are stored in OcrJob.rawResponse for review.
              // Business fields and links move only when the entire extraction
              // is trusted; NEEDS_REVIEW is an alternative to persistence.
              ...(complete
                ? {
                    supplierId,
                    supplierName: validValue(fields.supplierName) ?? ticket.supplierName,
                    material: validValue(fields.material) ?? ticket.material,
                    quantity: validValue(fields.quantity) ?? ticket.quantity,
                    // No default. An absent unit remains absent.
                    unit: validValue(fields.unit) ?? ticket.unit,
                    poNumber: finalPoNumber,
                    ticketNumber: validValue(fields.ticketNumber) ?? ticket.ticketNumber,
                    ticketDate:
                      fields.ticketDate.state === 'VALID'
                        ? isoDateToUtcDate(fields.ticketDate.value as string)
                        : ticket.ticketDate,
                    linkedOrderId,
                    status: ticketStatus,
                    linkMethod,
                  }
                : {}),
            },
          });

          await tx.ocrJob.update({
            where: { id: ocrJob.id },
            data: {
              status: complete ? OcrJobStatus.COMPLETED : OcrJobStatus.NEEDS_REVIEW,
              finishedAt: new Date(),
              rawResponse: provenance as any,
              structuredProvider: EXTRACTION_PROVIDER,
              structuredModel: outcome.fallback.model,
              fallbackUsed: outcome.fallback.used,
              reviewReasons,
              extractionConfidence: outcome.ocrConfidence,
              errorMessage: null,
            },
          });

          return written;
        },
        { timeout: 30_000 }
      );

      console.log(
        '[TicketService]',
        JSON.stringify({
          ticketId,
          outcome: complete ? 'COMPLETED' : 'NEEDS_REVIEW',
          reasonCount: reviewReasons.length,
          supplierMatch: resolution.method,
          autoLinked: complete && matchedOrderId !== null,
          fallbackUsed: outcome.fallback.used,
        })
      );

      return updatedTicket;
    } catch (error: any) {
      // Reserved for a document that produced nothing usable at all. A ticket
      // that was merely read incompletely is written above and marked
      // NEEDS_REVIEW; it never lands here and never enters the retry loop.
      await prisma.ocrJob.update({
        where: { id: ocrJob.id },
        data: {
          status: OcrJobStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: error?.message ?? 'Unknown error',
        },
      });
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
    // processed yet — the ticket simply never gained its fields and nothing said
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
        // Newest first: the review panel reads the most recent job to decide
        // whether the ticket still needs a person, and an unordered list left
        // that to insertion order.
        ocrJobs: { orderBy: { startedAt: 'desc' } },
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
