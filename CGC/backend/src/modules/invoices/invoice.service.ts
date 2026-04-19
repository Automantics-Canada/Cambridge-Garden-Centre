import { prisma } from '../../db/prisma.js';
import { compareTwoStrings } from 'string-similarity';
import { saveInvoiceImage } from '../../services/fileStorage.js';
import { extractExpenseFromLocalImage } from '../../services/invoiceOcr.service.js';
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

async function findSupplierByName(name: string | null) {
  if (!name) return null;
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
function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .replace(/type\s+/g, '')
    .replace(/[^a-z0-9\s]/g, '')
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
      // Fallback to first supplier or a "General" supplier
      supplier = await prisma.supplier.findFirst();
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

      let updatedSupplierId = invoice.supplierId;
      if (extracted.supplierName) {
        const found = await findSupplierByName(extracted.supplierName);
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

      // Clear existing line items
      await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });

      for (let i = 0; i < extracted.lineItems.length; i++) {
        const item = extracted.lineItems[i];
        if (!item) continue;

        let matchedOrderId: string | null = null;
        let matchedTicketIds: string[] = [];
        let negotiatedRateVal: number | null = null;
        let flags: LineItemFlag[] = [];
        let rateDiscrepancy: number | null = null;
        let qtyDiscrepancy: number | null = null;

        const linePo = item.poNumber || extracted.poNumber || null;

        // --- MATCH 1: Invoice Line to Ticket ---
        // 7.1 Match 1: Primary match: PO number on invoice line === PO number on ticket
        if (linePo) {
          const matchingTickets = await prisma.ticket.findMany({
            where: { poNumber: linePo, supplierId: updatedSupplierId },
          });
          if (matchingTickets.length > 0) {
            matchedTicketIds = matchingTickets.map(t => t.id);
          }
        }

        if (matchedTicketIds.length === 0) {
          // Secondary match (if no PO): supplier + date range + material type + quantity within 5% tolerance
          const invoiceDate = new Date(updatedInvoice.invoiceDate);
          const minDate = new Date(invoiceDate); minDate.setDate(minDate.getDate() - 3);
          const maxDate = new Date(invoiceDate); maxDate.setDate(maxDate.getDate() + 3);

          const potentialTickets = await prisma.ticket.findMany({
            where: {
              supplierId: updatedSupplierId,
              ticketDate: { gte: minDate, lte: maxDate },
            }
          });

          for (const ticket of potentialTickets) {
            if (ticket.material && stringsMatchFuzzy(ticket.material, item.description)) {
              const ticketQty = Number(ticket.quantity || 0);
              const diff = Math.abs(item.quantity - ticketQty);
              const tolerance = item.quantity * 0.05;
              if (diff <= tolerance) {
                matchedTicketIds.push(ticket.id);
                // In secondary match, we usually find one primary ticket, 
                // but let's allow finding multiple if they hit the tolerance.
                // Spec says "One invoice line can match multiple tickets".
              }
            }
          }
        }

        if (matchedTicketIds.length === 0) {
          flags.push(LineItemFlag.NO_TICKET);
        }

        // --- MATCH 2: Invoice Line to Order ---
        // 7.1 Match 2: Match via PO number: invoice line PO === order PO number
        if (linePo) {
          const orderMatch = await prisma.order.findFirst({
            where: { poNumber: linePo, supplierId: updatedSupplierId },
          });
          if (orderMatch) {
            matchedOrderId = orderMatch.id;
            const orderQty = Number(orderMatch.quantity);
            const diff = item.quantity - orderQty;
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

        const rateMatch = allRates.find(r => stringsMatchFuzzy(r.productName, item.description));

        if (rateMatch) {
          negotiatedRateVal = Number(rateMatch.rate);
          const diff = item.unitPrice - negotiatedRateVal;
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

        await prisma.invoiceLineItem.create({
          data: {
            invoiceId,
            lineNumber: i + 1,
            description: item.description,
            poNumber: linePo,
            quantity: item.quantity,
            unit: 'ea', // Should probably extract unit from Bedrock too, but keeping 'ea' for now
            unitRate: item.unitPrice,
            lineTotal: item.totalPrice,
            matchedOrderId,
            matchedTickets: {
              connect: matchedTicketIds.map(id => ({ id }))
            },
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

  async getInvoices(filters?: { status?: InvoiceStatus; supplierId?: string }) {
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

  async getInvoiceById(id: string) {
    return prisma.invoice.findUnique({
      where: { id },
      include: {
        supplier: true,
        lineItems: {
          include: { matchedOrder: true, matchedTickets: true }
        },
        verifiedBy: true,
        ocrJobs: { orderBy: { startedAt: 'desc' } },
      },
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
  }
};
