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

async function findSupplierByName(name: string | null) {
  if (!name) return null;
  const logPath = path.join(process.cwd(), 'ocr_debug.log');
  fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] Attempting match for: "${name}"\n`);

  const supplier = await prisma.supplier.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
    },
  });
  if (supplier) {
    fs.appendFileSync(logPath, `Exact match found: ${supplier.name}\n`);
    return supplier;
  }

  // Try contains
  const containsSupplier = await prisma.supplier.findFirst({
    where: {
      name: { contains: name, mode: 'insensitive' },
    },
  });
  if (containsSupplier) {
    fs.appendFileSync(logPath, `Contains match found: ${containsSupplier.name}\n`);
    return containsSupplier;
  }

  // Final fallback: Fuzzy match against all suppliers
  fs.appendFileSync(logPath, `No direct match. Candidates:\n`);
  const allSuppliers = await prisma.supplier.findMany();
  let bestMatch = null;
  let highestSimilarity = 0;

  for (const s of allSuppliers) {
    const similarity = compareTwoStrings(name.toLowerCase(), s.name.toLowerCase());
    fs.appendFileSync(logPath, ` - Candidate: "${s.name}" | Score: ${similarity.toFixed(4)}\n`);
    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      bestMatch = s;
    }
  }

  if (bestMatch && highestSimilarity > 0.3) {
    fs.appendFileSync(logPath, `WINNER: "${bestMatch.name}" (Score: ${highestSimilarity.toFixed(4)})\n`);
    return bestMatch;
  }

  fs.appendFileSync(logPath, `FAILURE: No supplier matched.\n`);
  return null;
}

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

      console.log(`[InvoiceService] OCR COMPLETE for Invoice ${invoiceId}. Final Supplier: ${updatedSupplierId}. Raw extracted name: "${extracted.supplierName}"`);

        await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
        fs.appendFileSync(logPath, `\nProcessing ${extracted.lineItems.length} line items...\n`);

        for (let i = 0; i < extracted.lineItems.length; i++) {
          const item = extracted.lineItems[i];
          if (!item) continue;
          
          fs.appendFileSync(logPath, `Line ${i + 1}: "${item.description}" | Unit: "${item.unit}"\n`);

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
          
          const orderMatch = potentialOrders.find(o => stringsMatchFuzzy(o.product, item.description));

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

        // --- Calculation ---
        let approvedTotal: number | null = null;
        if (negotiatedRateVal) {
          approvedTotal = item.quantity * negotiatedRateVal;
        }

        await prisma.invoiceLineItem.create({
          data: {
            invoiceId,
            lineNumber: i + 1,
            description: item.description,
            poNumber: linePo,
            quantity: item.quantity,
            unit: item.unit ?? 'ea',
            unitRate: item.unitPrice,
            lineTotal: item.totalPrice,
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
          include: { 
            matchedOrder: {
              include: { deliveries: { include: { driver: true } } }
            }, 
            matchedTickets: true 
          }
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
