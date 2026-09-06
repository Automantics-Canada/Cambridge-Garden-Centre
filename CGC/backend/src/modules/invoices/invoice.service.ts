import { prisma } from '../../db/prisma.js';
import { compareTwoStrings } from 'string-similarity';
import { saveInvoiceImage } from '../../services/fileStorage.js';
import { extractInvoiceFromUrl } from '../../services/extraction/extraction.service.js';
import { compareUnits } from '../../lib/units.js';
import { normalizeProductName } from '../../lib/productName.js';
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
 * Holding record for an invoice whose sender could not be identified on arrival.
 *
 * `Invoice.supplierId` is non-nullable, so every ingested invoice must point at
 * some supplier row. Pointing an unidentified one at a real company misattributes
 * money and matches its lines against that company's negotiated rates. This row
 * exists so "we do not know yet" is representable.
 */
export const UNIDENTIFIED_SUPPLIER_NAME = 'Unidentified supplier';

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
// spreading parsed query params â€” so each field must accept an explicit
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
 * `limit` has a hard ceiling so no caller â€” including a stale frontend still
 * asking for `limit=1000` â€” can turn the list endpoint back into a full-ledger
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
 * total would disagree with the rows returned â€” the same property
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
/**
 * Shared with the alias writer in SupplierService. Both ends of an alias
 * lookup must normalise identically or every alias misses.
 */
const normalizeString = normalizeProductName;


/**
 * Agreed rate for a line, resolved through a recorded alias.
 *
 * An alias is a person's confirmed answer to "which of our products is this
 * supplier's wording?", so it is exact and beats the fuzzy fallback outright.
 * Returns null when nothing has been mapped, leaving the caller to fall back.
 */
async function resolveRateByAlias<T extends { productName: string }>(
  supplierId: string,
  description: string,
  rates: T[]
): Promise<T | null> {
  if (!supplierId || !description.trim()) return null;

  const alias = await prisma.supplierProductAlias.findUnique({
    where: {
      supplierId_aliasText: {
        supplierId,
        aliasText: normalizeString(description),
      },
    },
    select: { productName: true },
  });

  if (!alias) return null;

  const target = normalizeString(alias.productName);
  return rates.find(r => normalizeString(r.productName) === target) ?? null;
}

/**
 * Re-derives a line item's flag from what is currently recorded against it.
 *
 * Manual link and unlink handlers used to stamp a literal flag â€” `OK` on link,
 * `NO_ORDER` on unlink â€” which meant attaching an order cleared an unrelated
 * rate or quantity warning, and detaching one erased them too. The flag is a
 * conclusion, so it is recomputed rather than assigned.
 *
 * `UNIT_MISMATCH` cannot be re-derived after the fact: like `RATE_UNKNOWN` it
 * leaves `negotiatedRate` null, and the schema keeps one flag per line rather
 * than a set. It is therefore carried over when it was already the verdict.
 */
async function recomputeLineItemFlag(lineItemId: string): Promise<LineItemFlag> {
  const line = await prisma.invoiceLineItem.findUnique({
    where: { id: lineItemId },
    select: {
      flag: true,
      matchedOrderId: true,
      negotiatedRate: true,
      rateDiscrepancy: true,
      qtyDiscrepancy: true,
      matchedTickets: { select: { id: true } },
    },
  });

  if (!line) throw new Error(`Line item not found: ${lineItemId}`);

  const flags: LineItemFlag[] = [];

  if (!line.matchedOrderId) flags.push(LineItemFlag.NO_ORDER);
  if (line.matchedTickets.length === 0) flags.push(LineItemFlag.NO_TICKET);
  if (line.qtyDiscrepancy !== null) flags.push(LineItemFlag.QTY_MISMATCH);

  if (line.rateDiscrepancy !== null) {
    flags.push(LineItemFlag.RATE_MISMATCH);
  } else if (line.negotiatedRate === null) {
    flags.push(
      line.flag === LineItemFlag.UNIT_MISMATCH
        ? LineItemFlag.UNIT_MISMATCH
        : LineItemFlag.RATE_UNKNOWN
    );
  }

  const flag =
    flags.length > 1 ? LineItemFlag.MULTIPLE_FLAGS
    : flags.length === 1 ? flags[0]!
    : LineItemFlag.OK;

  await prisma.invoiceLineItem.update({ where: { id: lineItemId }, data: { flag } });
  return flag;
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

    const byDomain = domain
      ? await prisma.supplier.findFirst({ where: { emailDomains: { hasSome: [domain] } } })
      : null;

    // Try fuzzy match on name in subject
    let supplier: { id: string } | null = byDomain;
    if (!supplier) {
      const allSuppliers = await prisma.supplier.findMany();
      supplier = allSuppliers.find(s => params.subject.toLowerCase().includes(s.name.toLowerCase())) || null;
    }

    if (!supplier) {
      // `Invoice.supplierId` is non-nullable, so an unattributed invoice still
      // needs something to point at. It used to point at a named real supplier
      // ('Stone Creek Aggregates', then whichever row came back first), which
      // attributed real money to a company that had not sent that invoice, and
      // then matched its line items against that company's negotiated rates.
      //
      // A dedicated holding record keeps the row honest: it reads as
      // unattributed everywhere it appears, carries no negotiated rates of its
      // own, and is replaced by `processInvoiceOcr` as soon as OCR identifies
      // the real sender. Making the column nullable is the proper fix.
      const { SupplierService } = await import('../supplier/supplier.service.js');
      supplier = await SupplierService.findOrCreateSupplier(UNIDENTIFIED_SUPPLIER_NAME);
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
        provider: OcrProvider.OPENAI,
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
      const extracted = await extractInvoiceFromUrl(invoice.fileUrl);

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
          ocrRawText: JSON.stringify(extracted),
          OcrJobStatus: OcrJobStatus.COMPLETED,
        },
      });

      console.log(`[InvoiceService] OCR COMPLETE for Invoice ${invoiceId}. Final Supplier: ${updatedSupplierId}. Raw extracted name: "${extracted.supplierName}"`);

        await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
        console.log(`[InvoiceService] Processing ${extracted.lineItems.length} line items for invoice ${invoiceId}`);

        for (let i = 0; i < extracted.lineItems.length; i++) {
          const item = extracted.lineItems[i];
          if (!item) continue;
          
          // Normalize values to avoid null crashes on required DB fields
          const description = item.description || 'Unknown Item';
          const quantity = Number(item.quantity) || 0;
          const unitRate = Number(item.unitPrice) || 0;
          const lineTotal = Number(item.totalPrice) || (quantity * unitRate);
          // A line whose unit could not be read is recorded as unknown, not as
          // "each". `normaliseUnit` does not recognise "unknown", so the
          // quantity check below refuses to compare and the line is flagged for
          // a person â€” where defaulting to "each" made it silently comparable
          // against any ticket also counted in each, and produced a confident
          // verdict from a unit nobody had actually read.
          const unit = item.unit ?? 'unknown';

        let matchedOrderId: string | null = null;
        let matchedTicketIds: string[] = [];
        let negotiatedRateVal: number | null = null;
        let flags: LineItemFlag[] = [];
        let rateDiscrepancy: number | null = null;
        let qtyDiscrepancy: number | null = null;

        const linePo = item.poNumber || extracted.poNumber || null;

        // --- MATCH 1: Invoice Line to Ticket ---
        // Link the tickets carrying this PO, then check that what the tickets
        // say was delivered is what the invoice is charging for.
        //
        // Tickets used to be attached and never looked at again. The ticket is
        // the only independent record of what actually moved â€” the supplier
        // writes the invoice, but the contractor signs the ticket â€” so an
        // invoice that bills more than the tickets account for is the single
        // most useful thing this system can catch.
        let ticketedQuantity: number | null = null;
        if (linePo) {
          const matchingTickets = await prisma.ticket.findMany({
            where: { poNumber: linePo, supplierId: updatedSupplierId },
            select: { id: true, quantity: true, unit: true, material: true },
          });

          if (matchingTickets.length > 0) {
            matchedTicketIds = matchingTickets.map(t => t.id);

            // Only tickets recorded in the same unit as the invoice line can be
            // summed against it. Mixing tonnes and cubic yards into one total
            // would produce a confident, wrong number.
            const comparable = matchingTickets.filter(
              t => t.quantity !== null && compareUnits(unit, t.unit).comparable
            );

            if (comparable.length > 0) {
              ticketedQuantity = comparable.reduce((sum, t) => sum + Number(t.quantity), 0);
            } else {
              console.warn(
                `[InvoiceService] PO ${linePo}: ${matchingTickets.length} ticket(s) attached but ` +
                `none are recorded in "${unit}", so the quantity was not checked.`
              );
            }
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
          } else {
            flags.push(LineItemFlag.NO_ORDER);
          }
        } else {
          flags.push(LineItemFlag.NO_ORDER);
        }

        // --- Quantity check ---
        // Preference order: signed tickets first, then the order.
        //
        // The order is what was asked for; the tickets are what was received.
        // Billing is supposed to follow what was received, so tickets win when
        // they are usable. Previously only the order was checked, and only for
        // over-billing â€” an invoice for less than was ordered passed silently,
        // which hides a short delivery just as effectively.
        const expectedQuantity =
          ticketedQuantity !== null
            ? ticketedQuantity
            : matchedOrderId
            ? Number((await prisma.order.findUnique({
                where: { id: matchedOrderId },
                select: { quantity: true },
              }))?.quantity ?? Number.NaN)
            : Number.NaN;

        if (Number.isFinite(expectedQuantity) && expectedQuantity !== 0) {
          const diff = quantity - expectedQuantity;
          const tolerance = Math.abs(expectedQuantity) * 0.02; // 2% either way
          if (Math.abs(diff) > tolerance) {
            flags.push(LineItemFlag.QTY_MISMATCH);
            qtyDiscrepancy = diff;
          }
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

        // An alias recorded for this supplier is an exact, human-confirmed
        // answer and always beats guessing at the product name.
        const aliasRate = await resolveRateByAlias(updatedSupplierId, description, allRates);
        const rateMatch = aliasRate ?? allRates.find(r => stringsMatchFuzzy(r.productName, description));

        if (!rateMatch) {
          flags.push(LineItemFlag.RATE_UNKNOWN);
        } else {
          // Both sides must be priced per the same unit before the numbers mean
          // anything. Without this, $8.10/tonne against $9.10/ton reads as a
          // clean ten percent overcharge that nobody committed.
          const units = compareUnits(unit, rateMatch.unit);

          if (!units.comparable) {
            flags.push(LineItemFlag.UNIT_MISMATCH);
            console.warn(
              `[InvoiceService] Line "${description}": invoice unit "${unit}" and agreed rate ` +
              `unit "${rateMatch.unit}" are not comparable (${units.reason}). Rate not applied.`
            );
          } else {
            negotiatedRateVal = Number(rateMatch.rate);
            const diff = unitRate - negotiatedRateVal;

            // Recorded in both directions. Being under-billed is still a
            // discrepancy worth seeing â€” it usually means the wrong rate or the
            // wrong product, and the correction tends to arrive later.
            if (Math.abs(diff) > 0.01) {
              flags.push(LineItemFlag.RATE_MISMATCH);
              rateDiscrepancy = diff;
            }
          }
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
      //
      // Only lines with an applicable agreed rate can be totalled. Lines
      // without one were previously counted at a rate of zero, so a single
      // unpriced product dragged the expected total far below the billed total
      // and stamped a "total amount mismatch" dispute on an invoice that was
      // very likely correct. On a supplier who has just introduced a product,
      // that fired on every invoice â€” and a dispute note that is usually wrong
      // is one nobody reads.
      //
      // With unpriced lines present the totals are not comparable at all, so
      // the check is skipped and the reason is recorded instead.
      const lineItems = await prisma.invoiceLineItem.findMany({ where: { invoiceId } });
      const pricedLines = lineItems.filter(item => item.negotiatedRate !== null);
      const unpricedLines = lineItems.filter(item => item.negotiatedRate === null);

      const billedTotal = Number(updatedInvoice.totalAmount);

      if (unpricedLines.length > 0) {
        await prisma.invoice.update({
          where: { id: invoiceId },
          data: {
            disputeNote:
              `Total not checked: ${unpricedLines.length} of ${lineItems.length} line(s) have no ` +
              `applicable agreed rate (${unpricedLines.map(l => l.description).join('; ')}). ` +
              `Billed: $${billedTotal.toFixed(2)}. Add the missing rates, then reopen to re-check.`,
          },
        });
      } else if (lineItems.length > 0) {
        const totalApprovedSubtotal = pricedLines.reduce(
          (sum, item) => sum + Number(item.quantity) * Number(item.negotiatedRate),
          0
        );

        // HST is Ontario's 13%. Hard-coded because every supplier here is
        // Ontario-registered; revisit if that stops being true.
        const totalApprovedWithHst = totalApprovedSubtotal * 1.13;
        const totalDiscrepancy = Math.abs(totalApprovedWithHst - billedTotal);

        await prisma.invoice.update({
          where: { id: invoiceId },
          data: {
            disputeNote:
              totalDiscrepancy > 0.05
                ? `Total amount mismatch. Expected pay: $${totalApprovedWithHst.toFixed(2)} (Subtotal: $${totalApprovedSubtotal.toFixed(2)} + 13% HST). Billed: $${billedTotal.toFixed(2)}.`
                : null,
          },
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
    // Clearing NO_ORDER is all this link earns. It used to set the flag to OK
    // outright, which also wiped a live RATE_MISMATCH or QTY_MISMATCH â€” so
    // attaching an order silently dismissed a price warning nobody had looked
    // at. `recomputeLineItemFlag` re-derives the flag from the current facts.
    const updated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedOrderId: orderId,
      },
      include: { invoice: true }
    });

    const flag = await recomputeLineItemFlag(lineItemId);

    await prisma.auditLog.create({
      data: {
        entityType: AuditEntityType.INVOICE,
        entityId: updated.invoiceId,
        actionType: AuditActionType.SYSTEM_CONFIG_CHANGE,
        performedById: userId,
        details: { action: 'MANUAL_ORDER_LINK', lineItemId, orderId, resultingFlag: flag },
      },
    });

    return { ...updated, flag };
  },

  async linkTicketsToLineItem(lineItemId: string, ticketIds: string[], userId: string) {
    const updated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedTickets: {
          set: ticketIds.map(id => ({ id }))
        },
      },
      include: { invoice: true }
    });

    const flag = await recomputeLineItemFlag(lineItemId);

    await prisma.auditLog.create({
      data: {
        entityType: AuditEntityType.INVOICE,
        entityId: updated.invoiceId,
        actionType: AuditActionType.SYSTEM_CONFIG_CHANGE,
        performedById: userId,
        details: { action: 'MANUAL_TICKET_LINK', lineItemId, ticketIds, resultingFlag: flag },
      },
    });

    return { ...updated, flag };
  },

  async unlinkOrderFromLineItem(lineItemId: string, userId: string) {
    const updated = await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedOrderId: null,
      },
      include: { invoice: true }
    });

    const flag = await recomputeLineItemFlag(lineItemId);

    await prisma.auditLog.create({
      data: {
        entityType: AuditEntityType.INVOICE,
        entityId: updated.invoiceId,
        actionType: AuditActionType.SYSTEM_CONFIG_CHANGE,
        performedById: userId,
        details: { action: 'MANUAL_ORDER_UNLINK', lineItemId, resultingFlag: flag },
      },
    });

    return { ...updated, flag };
  },

  async unlinkTicketFromLineItem(lineItemId: string, ticketId: string, userId: string) {
    await prisma.invoiceLineItem.update({
      where: { id: lineItemId },
      data: {
        matchedTickets: {
          disconnect: { id: ticketId }
        }
      },
    });

    // Removing a ticket only ever adds NO_TICKET back; it must not clear a rate
    // or quantity problem that is still true.
    await recomputeLineItemFlag(lineItemId);

    const finalUpdated = await prisma.invoiceLineItem.findUniqueOrThrow({
      where: { id: lineItemId },
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

