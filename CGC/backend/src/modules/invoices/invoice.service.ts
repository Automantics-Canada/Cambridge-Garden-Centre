import { prisma } from '../../db/prisma.js';
import { compareTwoStrings } from 'string-similarity';
import { saveInvoiceImage } from '../../services/fileStorage.js';
import { extractExpenseFromLocalImage } from '../../services/invoiceOcr.service.js';
import fs from 'fs';
import path from 'path';
import {
  InvoiceStatus,
  SenderType,
  OcrJobType,
  OcrProvider,
  OcrJobStatus,
  LineItemFlag,
  AuditEntityType,
  AuditActionType,
} from '@prisma/client';

/**
 * Field projections for relations serialized straight back to the client.
 *
 * `include: { x: true }` returns every scalar on `x`. On `User` that includes
 * `passwordHash`; on `Driver` it includes `ratePerDelivery` / `ratePerTrip`
 * and personal contact details. Neither belongs in an invoice response, so
 * every user- or driver-facing include below goes through these projections.
 *
 * Only widen these if the UI genuinely needs the field.
 */
export const VERIFIED_BY_PUBLIC_FIELDS = { id: true, name: true } as const;
export const DRIVER_PUBLIC_FIELDS = { id: true, name: true } as const;

/**
 * Projection returned by `getInvoices`. Exported so the shape is testable.
 *
 * This used to be `include: { supplier: true, lineItems: true, ... }`, which
 * shipped every column of every line item of every invoice to a list screen
 * that only renders a count and a flagged badge. The two `_count` aggregates
 * below replace the whole line-item array with two integers; the full graph is
 * still available from `getInvoiceById` once the user opens a row.
 */
export const INVOICE_LIST_SELECT = {
  id: true,
  invoiceNumber: true,
  senderType: true,
  supplierId: true,
  invoiceDate: true,
  totalAmount: true,
  currency: true,
  status: true,
  receivedAt: true,
  emailFrom: true,
  verifiedAt: true,
  supplier: { select: { id: true, name: true } },
  verifiedBy: { select: VERIFIED_BY_PUBLIC_FIELDS },
  // Total line count comes from the aggregate; the flagged rows are fetched as
  // bare ids because a filtered `_count` cannot coexist with an unfiltered one
  // on the same relation. Both collapse to integers in `toInvoiceListRow`.
  _count: { select: { lineItems: true } },
  lineItems: {
    where: { flag: { not: LineItemFlag.OK } },
    select: { id: true },
  },
} as const;

export const DEFAULT_INVOICE_PAGE_SIZE = 25;
/** Ceiling on `?limit=`, so one caller cannot ask for the whole ledger again. */
export const MAX_INVOICE_PAGE_SIZE = 100;

// `exactOptionalPropertyTypes` is on, and the controller builds this object by
// spreading parsed query params — so each field must accept an explicit
// undefined rather than merely being absent.
export interface InvoiceListFilters {
  page?: number | undefined;
  limit?: number | undefined;
  status?: InvoiceStatus | undefined;
  supplierId?: string | undefined;
  senderType?: SenderType | undefined;
  search?: string | undefined;
  flaggedOnly?: boolean | undefined;
  startDate?: Date | undefined;
  endDate?: Date | undefined;
}

/**
 * Clamped page/limit.
 *
 * `limit` has a hard ceiling so no caller — including a stale frontend still
 * asking for `limit=1000` — can turn the list endpoint back into a full-ledger
 * download.
 */
export function resolveInvoicePaging(filters: InvoiceListFilters = {}) {
  const page = Math.max(1, Math.trunc(Number(filters.page) || 1));
  const requested = Math.trunc(Number(filters.limit) || DEFAULT_INVOICE_PAGE_SIZE);
  const limit = Math.min(MAX_INVOICE_PAGE_SIZE, Math.max(1, requested));
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Shared predicate for the list and its count.
 *
 * Both call sites use this one builder; if they drifted apart the reported
 * total would disagree with the rows returned — the same property
 * `buildTicketWhere` protects on the tickets endpoint.
 */
export function buildInvoiceWhere(filters: InvoiceListFilters = {}): Record<string, any> {
  const where: Record<string, any> = {};
  if (filters.status) where.status = filters.status;
  if (filters.supplierId) where.supplierId = filters.supplierId;
  if (filters.senderType) where.senderType = filters.senderType;
  if (filters.flaggedOnly) {
    where.lineItems = { some: { flag: { not: LineItemFlag.OK } } };
  }
  if (filters.startDate || filters.endDate) {
    const invoiceDate: Record<string, Date> = {};
    if (filters.startDate) invoiceDate.gte = filters.startDate;
    if (filters.endDate) invoiceDate.lte = filters.endDate;
    where.invoiceDate = invoiceDate;
  }
  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { invoiceNumber: { contains: search, mode: 'insensitive' } },
      { emailFrom: { contains: search, mode: 'insensitive' } },
      { supplier: { is: { name: { contains: search, mode: 'insensitive' } } } },
    ];
  }
  return where;
}

/** Row shape the invoice list screens actually render. */
export interface InvoiceListRow {
  id: string;
  invoiceNumber: string;
  senderType: SenderType;
  supplierId: string;
  invoiceDate: Date;
  totalAmount: unknown;
  currency: string;
  status: InvoiceStatus;
  receivedAt: Date;
  emailFrom: string;
  verifiedAt: Date | null;
  supplier: { id: string; name: string } | null;
  verifiedBy: { id: string; name: string } | null;
  lineItemCount: number;
  flaggedCount: number;
}

/** Collapses the two line-item aggregates into plain counters. */
export function toInvoiceListRow(row: any): InvoiceListRow {
  const { _count, lineItems, ...rest } = row;
  return {
    ...rest,
    lineItemCount: _count?.lineItems ?? 0,
    flaggedCount: Array.isArray(lineItems) ? lineItems.length : 0,
  };
}

/** Minimal invoice fields rendered by the Dashboard's five recent rows. */
export const DASHBOARD_INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  invoiceDate: true,
  totalAmount: true,
  currency: true,
  status: true,
  receivedAt: true,
  supplier: { select: { id: true, name: true } },
} as const;

/** Relations returned by `getInvoiceById`. Exported so the projection is testable. */
export const INVOICE_DETAIL_INCLUDE = {
  supplier: true,
  lineItems: {
    include: {
      matchedOrder: {
        include: {
          deliveries: {
            include: { driver: { select: DRIVER_PUBLIC_FIELDS } },
          },
        },
      },
      matchedTickets: true,
    },
  },
  verifiedBy: { select: VERIFIED_BY_PUBLIC_FIELDS },
  ocrJobs: { orderBy: { startedAt: 'desc' } },
} as const;



/**
 * Normalizes product names for fuzzy matching.
 * e.g., "Type A Gravel" -> "a gravel"
 */
function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .replace(/type\s+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ') // Replace non-alphanumeric with space instead of deleting (handles hyphens)
    .replace(/\s+/g, ' ')
    .trim();
}


function stringsMatchFuzzy(a: string, b: string): boolean {
  const normA = normalizeString(a);
  const normB = normalizeString(b);
  const similarity = compareTwoStrings(normA, normB);
  return similarity > 0.6 || normA.includes(normB) || normB.includes(normA);
}

export const InvoiceService = {
  async ingestEmailInvoice(params: {
    buffer: Buffer;
    originalName: string;
    fromEmail: string;
    subject: string;
    gmailMessageId: string;
  }) {
    const fileUrl = await saveInvoiceImage(params.buffer, params.originalName);

    // Find supplier by email domain or keywords
    const match = params.fromEmail.match(/@(.+)$/);
    const domain = (match?.[1]?.split('>')[0] ?? '').toLowerCase();

    let supplier = await prisma.supplier.findFirst({
      where: domain ? { emailDomains: { hasSome: [domain] } } : {},
    });

    if (!supplier) {
      // Try fuzzy match on name in subject
      const allSuppliers = await prisma.supplier.findMany();
      supplier = allSuppliers.find(s => params.subject.toLowerCase().includes(s.name.toLowerCase())) || null;
    }

    if (!supplier) {
      // No supplier matched — use a placeholder. OCR will resolve the correct supplier.
      // Don't blindly pick the first supplier as that causes wrong assignments.
      supplier = await prisma.supplier.findFirst({ where: { name: 'Stone Creek Aggregates' } })
        ?? await prisma.supplier.findFirst();
    }

    if (!supplier) throw new Error('No supplier found in the system to link to');

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `PENDING-${Date.now()}`,
        senderType: SenderType.SUPPLIER,
        supplierId: supplier.id,
        invoiceDate: new Date(),
        totalAmount: 0,
        currency: 'CAD',
        fileUrl,
        emailFrom: params.fromEmail,
        emailSubject: params.subject,
        gmailMessageId: params.gmailMessageId,
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

  async processInvoiceOcr(invoiceId: string) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { ocrJobs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    if (!invoice) throw new Error('Invoice not found');

    const ocrJob = invoice.ocrJobs[0];
    if (ocrJob) {
      await prisma.ocrJob.update({
        where: { id: ocrJob.id },
        data: { status: OcrJobStatus.PROCESSING, startedAt: new Date() },
      });
    }

    try {
      const extracted = await extractExpenseFromLocalImage(invoice.fileUrl);
      const logPath = path.join(process.cwd(), 'ocr_debug.log');

      let updatedSupplierId = invoice.supplierId;
      if (extracted.supplierName) {
        const { SupplierService } = await import('../supplier/supplier.service.js');
        const found = await SupplierService.findOrCreateSupplier(extracted.supplierName);
        if (found) updatedSupplierId = found.id;
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

      console.log(`[InvoiceService] OCR COMPLETE for Invoice ${invoiceId}. Final Supplier: ${updatedSupplierId}. Raw extracted name: "${extracted.supplierName}"`);

        await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
        fs.appendFileSync(logPath, `\nProcessing ${extracted.lineItems.length} line items...\n`);

        for (let i = 0; i < extracted.lineItems.length; i++) {
          const item = extracted.lineItems[i];
          if (!item) continue;
          
          // Normalize values to avoid null crashes on required DB fields
          const description = item.description || 'Unknown Item';
          const quantity = Number(item.quantity) || 0;
          const unitRate = Number(item.unitPrice) || 0;
          const lineTotal = Number(item.totalPrice) || (quantity * unitRate);
          const unit = item.unit ? item.unit.trim() : 'ea';

          fs.appendFileSync(logPath, `Line ${i + 1}: "${description}" | Unit: "${unit}"\n`);

        let matchedOrderId: string | null = null;
        let matchedTicketIds: string[] = [];
        let negotiatedRateVal: number | null = null;
        let flags: LineItemFlag[] = [];
        let rateDiscrepancy: number | null = null;
        let qtyDiscrepancy: number | null = null;

        const linePo = item.poNumber || extracted.poNumber || null;

        // --- MATCH 1: Invoice Line to Ticket ---
        // Simplified: link all tickets with the same PO to this invoice line
        if (linePo) {
          const matchingTickets = await prisma.ticket.findMany({
            where: { poNumber: linePo, supplierId: updatedSupplierId },
          });
          if (matchingTickets.length > 0) {
            matchedTicketIds = matchingTickets.map(t => t.id);
          }
        }

        if (matchedTicketIds.length === 0) {
          flags.push(LineItemFlag.NO_TICKET);
        }

        // --- MATCH 2: Invoice Line to Order ---
        // Match 2: Match via PO number AND material name (fuzzy)
        if (linePo) {
          const potentialOrders = await prisma.order.findMany({
            where: { poNumber: linePo, supplierId: updatedSupplierId },
          });
          
          const orderMatch = potentialOrders.find(o => stringsMatchFuzzy(o.product ?? '', description ?? ''));

          if (orderMatch) {
            matchedOrderId = orderMatch.id;
            const orderQty = Number(orderMatch.quantity);
            const diff = quantity - orderQty;
            const tolerance = orderQty * 0.02; // 2% tolerance
            if (diff > tolerance) {
              flags.push(LineItemFlag.QTY_MISMATCH);
              qtyDiscrepancy = diff;
            }
          } else {
            flags.push(LineItemFlag.NO_ORDER);
          }
        } else {
          flags.push(LineItemFlag.NO_ORDER);
        }

        // --- MATCH 3: Rate Match ---
        // 7.1 Match 3: Look up negotiated_rates table
        const allRates = await prisma.negotiatedRate.findMany({
          where: {
            supplierId: updatedSupplierId,
            effectiveFrom: { lte: new Date(updatedInvoice.invoiceDate) },
            OR: [
              { effectiveTo: null },
              { effectiveTo: { gte: new Date(updatedInvoice.invoiceDate) } }
            ]
          },
        });

        const rateMatch = allRates.find(r => stringsMatchFuzzy(r.productName, description));

        if (rateMatch) {
          negotiatedRateVal = Number(rateMatch.rate);
          const diff = unitRate - negotiatedRateVal;
          if (diff > 0.01) {
            flags.push(LineItemFlag.RATE_MISMATCH);
            rateDiscrepancy = diff;
          } else if (diff < 0) {
            // informational only if billing less - flag remains OK unless other issues
          }
        } else {
          flags.push(LineItemFlag.RATE_UNKNOWN);
        }

        // --- Final Flagging ---
        // 7.2 Flag Definitions
        let finalFlag: LineItemFlag = LineItemFlag.OK;
        if (flags.length > 1) {
          finalFlag = LineItemFlag.MULTIPLE_FLAGS;
        } else if (flags.length === 1) {
          finalFlag = flags[0] as LineItemFlag;
        }

        // --- Calculation ---
        let approvedTotal: number | null = null;
        if (negotiatedRateVal) {
          approvedTotal = quantity * negotiatedRateVal;
        }

        await prisma.invoiceLineItem.create({
          data: {
            invoiceId,
            lineNumber: i + 1,
            description,
            poNumber: linePo,
            quantity,
            unit,
            unitRate,
            lineTotal,
            matchedOrderId,
            matchedTickets: {
              connect: matchedTicketIds.map(id => ({ id }))
            },
            negotiatedRate: negotiatedRateVal,
            rateDiscrepancy,
            qtyDiscrepancy,
            approvedTotal,
            flag: finalFlag,
          }
        });
      }

      // --- Total Discrepancy Match ---
      // Calculate sum of approved line item subtotals
      const lineItems = await prisma.invoiceLineItem.findMany({ where: { invoiceId } });
      const totalApprovedSubtotal = lineItems.reduce((sum, item) => {
        const rate = item.negotiatedRate ? Number(item.negotiatedRate) : 0;
        return sum + (Number(item.quantity) * rate);
      }, 0);

      const totalApprovedWithHst = totalApprovedSubtotal * 1.13;
      const billedTotal = Number(updatedInvoice.totalAmount);
      const totalDiscrepancy = Math.abs(totalApprovedWithHst - billedTotal);

      // Match with final amount - if difference > $0.05, update disputeNote
      if (totalDiscrepancy > 0.05) {
        await prisma.invoice.update({
          where: { id: invoiceId },
          data: {
            disputeNote: `Total amount mismatch. Expected pay: $${totalApprovedWithHst.toFixed(2)} (Subtotal: $${totalApprovedSubtotal.toFixed(2)} + 13% HST). Billed: $${billedTotal.toFixed(2)}.`
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
    } catch (error: any) {
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

  /**
   * Paginated, server-filtered invoice list.
   *
   * Every list screen previously pulled the entire ledger and filtered/paged in
   * the browser. Filtering and paging now happen in Postgres against the
   * `[status, receivedAt desc]` index, so the response is bounded by `limit`
   * regardless of how many invoices exist.
   */
  async getInvoices(filters: InvoiceListFilters = {}) {
    const { page, limit, skip } = resolveInvoicePaging(filters);
    const where = buildInvoiceWhere(filters);

    const [rows, totalCount] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: [
          { receivedAt: 'desc' },
          { invoiceDate: 'desc' },
        ],
        skip,
        take: limit,
        select: INVOICE_LIST_SELECT,
      }),
      prisma.invoice.count({ where }),
    ]);

    return {
      data: rows.map(toInvoiceListRow),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
    };
  },

  async getDashboardSummary() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [recentInvoices, pendingCount, disputedCount, totalMonthly] = await Promise.all([
      prisma.invoice.findMany({
        orderBy: [
          { receivedAt: 'desc' },
          { invoiceDate: 'desc' },
        ],
        take: 5,
        select: DASHBOARD_INVOICE_SELECT,
      }),
      prisma.invoice.count({ where: { status: InvoiceStatus.PENDING_REVIEW } }),
      prisma.invoice.count({ where: { status: InvoiceStatus.DISPUTED } }),
      prisma.invoice.count({ where: { receivedAt: { gte: monthStart } } }),
    ]);

    return {
      recentInvoices,
      stats: {
        pendingCount,
        disputedCount,
        totalMonthly,
        savingsDetected: 0,
      },
    };
  },

  async getInvoiceById(id: string) {
    return prisma.invoice.findUnique({
      where: { id },
      include: INVOICE_DETAIL_INCLUDE,
    });
  },

  async verifyInvoice(id: string, userId: string) {
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

  async disputeInvoice(id: string, userId: string, disputeNote: string) {
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

  async reopenInvoice(id: string, userId: string, reason: string) {
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
  },

  async linkOrderToLineItem(lineItemId: string, orderId: string, userId: string) {
    const updated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedOrderId: orderId,
        flag: 'OK', // Reset flag since we manually matched it
      },
      include: { invoice: true }
    });

    await prisma.auditLog.create({
      data: {
        entityType: AuditEntityType.INVOICE,
        entityId: updated.invoiceId,
        actionType: AuditActionType.SYSTEM_CONFIG_CHANGE,
        performedById: userId,
        details: { action: 'MANUAL_ORDER_LINK', lineItemId, orderId },
      },
    });

    return updated;
  },

  async linkTicketsToLineItem(lineItemId: string, ticketIds: string[], userId: string) {
    const updated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedTickets: {
          set: ticketIds.map(id => ({ id }))
        },
        flag: 'OK'
      },
      include: { invoice: true }
    });

    await prisma.auditLog.create({
      data: {
        entityType: AuditEntityType.INVOICE,
        entityId: updated.invoiceId,
        actionType: AuditActionType.SYSTEM_CONFIG_CHANGE,
        performedById: userId,
        details: { action: 'MANUAL_TICKET_LINK', lineItemId, ticketIds },
      },
    });

    return updated;
  },

  async unlinkOrderFromLineItem(lineItemId: string, userId: string) {
    const updated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedOrderId: null,
        flag: 'NO_ORDER', // Reset flag since we manual unlinked
      },
      include: { invoice: true }
    });

    await prisma.auditLog.create({
      data: {
        entityType: AuditEntityType.INVOICE,
        entityId: updated.invoiceId,
        actionType: AuditActionType.SYSTEM_CONFIG_CHANGE,
        performedById: userId,
        details: { action: 'MANUAL_ORDER_UNLINK', lineItemId },
      },
    });

    return updated;
  },

  async unlinkTicketFromLineItem(lineItemId: string, ticketId: string, userId: string) {
    const updated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedTickets: {
          disconnect: { id: ticketId }
        }
      },
      include: {
        invoice: true,
        matchedTickets: true
      }
    });

    // Check if there are remaining tickets. If not, reset flag to NO_TICKET
    const remaining = updated.matchedTickets.length;
    const finalFlag = remaining > 0 ? 'OK' : 'NO_TICKET';

    const finalUpdated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        flag: finalFlag
      },
      include: { invoice: true }
    });

    await prisma.auditLog.create({
      data: {
        entityType: AuditEntityType.INVOICE,
        entityId: finalUpdated.invoiceId,
        actionType: AuditActionType.SYSTEM_CONFIG_CHANGE,
        performedById: userId,
        details: { action: 'MANUAL_TICKET_UNLINK', lineItemId, ticketId },
      },
    });

    return finalUpdated;
  }
};

