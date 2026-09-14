import { prisma } from '../../db/prisma.js';
import { saveInvoiceImage } from '../../services/fileStorage.js';
import { extractInvoiceFromUrl } from '../../services/extraction/extraction.service.js';
import { deriveLineItemFlag } from '../../lib/lineItemFlag.js';
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
      // The verdict and the reasoning behind it, for the evidence panel. The
      // desk must never render a status without the checks that produced it.
      matchResult: {
        select: {
          id: true,
          status: true,
          reason: true,
          evidence: true,
          orderId: true,
          candidateOrderIds: true,
          computedAt: true,
          resolution: true,
          resolvedAt: true,
          resolvedBy: { select: VERIFIED_BY_PUBLIC_FIELDS },
        },
      },
    },
  },
  verifiedBy: { select: VERIFIED_BY_PUBLIC_FIELDS },
  ocrJobs: { orderBy: { startedAt: 'desc' } },
} as const;



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
 *
 * The rule itself lives in `deriveLineItemFlag`, shared with the match engine's
 * projection, because the two reaching different conclusions about the same
 * line is the problem this whole change is about.
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

  const flag = deriveLineItemFlag({
    hasOrder: line.matchedOrderId !== null,
    ticketCount: line.matchedTickets.length,
    hasQuantityDiscrepancy: line.qtyDiscrepancy !== null,
    hasRateDiscrepancy: line.rateDiscrepancy !== null,
    hasAgreedRate: line.negotiatedRate !== null,
    // Carried over rather than re-derived: like RATE_UNKNOWN it leaves
    // `negotiatedRate` null, so nothing stored on the row afterwards can tell
    // the two apart. The engine says which it is when it writes the verdict.
    rateUnitMismatch: line.flag === LineItemFlag.UNIT_MISMATCH,
  });

  await prisma.invoiceLineItem.update({ where: { id: lineItemId }, data: { flag } });
  return flag;
}

/**
 * Re-extracting an invoice would have destroyed decisions somebody made.
 *
 * Carries a `code` so a route can say which failure this was, and
 * `retryable: false` so the OCR worker does not spend three attempts on
 * something no retry can fix.
 */
export class InvoiceLinesResolvedError extends Error {
  readonly code = 'INVOICE_LINES_RESOLVED';
  readonly retryable = false;
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'InvoiceLinesResolvedError';
  }
}

/**
 * Refuses to re-extract an invoice whose lines carry settled decisions.
 *
 * `processInvoiceOcr` deletes every line before writing the new ones, and both
 * `MatchResult` and `TicketClaim` cascade with the line. So re-running OCR
 * silently erased resolved verdicts — who approved what, and why — and
 * released the loads those approvals had spent, which frees them to be paid
 * for a second time on another invoice. That is precisely the failure the
 * claim mechanism exists to prevent, so it is refused rather than reported
 * afterwards.
 *
 * `force` is the deliberate way through: each verdict is reopened first, which
 * writes an audit entry naming who did it and releases the claims in the open.
 */
async function refuseOrReleaseSettledLines(
  invoiceId: string,
  options: { force?: boolean; userId?: string }
): Promise<void> {
  const settled = await prisma.invoiceLineItem.findMany({
    where: {
      invoiceId,
      OR: [{ matchResult: { resolution: { not: null } } }, { ticketClaims: { some: {} } }],
    },
    select: {
      id: true,
      lineNumber: true,
      matchResult: { select: { id: true, resolution: true } },
      _count: { select: { ticketClaims: true } },
    },
    orderBy: { lineNumber: 'asc' },
  });

  if (settled.length === 0) return;

  const described = settled
    .map((line) => {
      const parts = [
        line.matchResult?.resolution ? line.matchResult.resolution.toLowerCase() : null,
        line._count.ticketClaims > 0
          ? `${line._count.ticketClaims} claimed ticket${line._count.ticketClaims === 1 ? '' : 's'}`
          : null,
      ].filter(Boolean);
      return `line ${line.lineNumber} (${parts.join(', ')})`;
    })
    .join('; ');

  if (!options.force) {
    throw new InvoiceLinesResolvedError(
      `This invoice cannot be read again: ${described} already carry decisions somebody made. ` +
        'Reopen them first if the extraction really needs to be replaced.'
    );
  }

  if (!options.userId) {
    throw new InvoiceLinesResolvedError(
      'Re-reading an invoice with settled lines has to be attributed to somebody, ' +
        'because reopening their decisions is recorded against a user.'
    );
  }

  const { reopenMatchResult } = await import('../matching/resolveMatch.js');
  for (const line of settled) {
    if (!line.matchResult) continue;
    await reopenMatchResult({
      matchResultId: line.matchResult.id,
      userId: options.userId,
      note: 'Reopened automatically so this invoice could be read again.',
      // Every line being reopened here is about to be deleted, and the lines
      // replacing them are decided a moment later. Re-deciding each one on its
      // way out is work thrown away.
      recomputeOthers: false,
    });
  }

  // A claim with no verdict behind it cannot be reopened, and deleting it
  // silently is the data loss this function exists to stop.
  const stranded = await prisma.ticketClaim.count({
    where: { invoiceLineId: { in: settled.map((line) => line.id) } },
  });
  if (stranded > 0) {
    throw new InvoiceLinesResolvedError(
      `${stranded} ticket claim(s) on this invoice are not attached to a verdict that could be ` +
        'reopened. Release them on the verification desk before re-reading the invoice.'
    );
  }
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

  /**
   * Reads an invoice and decides, line by line, whether it is safe to pay.
   *
   * `force` replaces an extraction whose lines somebody has already ruled on,
   * reopening those decisions first and recording who asked for it. Without it
   * such an invoice is refused, because re-reading destroys the decisions.
   */
  async processInvoiceOcr(
    invoiceId: string,
    options: { force?: boolean; userId?: string } = {}
  ) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { ocrJobs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    if (!invoice) throw new Error('Invoice not found');

    // Checked before the job is marked PROCESSING and before the model is
    // called: refusing costs nothing, and an extraction that cannot be stored
    // should not be paid for.
    await refuseOrReleaseSettledLines(invoiceId, options);

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

      // Pass one: write the lines exactly as they were read, and nothing more.
      //
      // Every line has to exist before any of them is judged, because two lines
      // billing one PO contend for the same tickets and each verdict has to be
      // able to see the other. Judging line 1 before line 2 was written let it
      // go green on tickets line 2 also claimed.
      const created: Array<{ id: string; description: string }> = [];

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
        const linePo = item.poNumber || extracted.poNumber || null;

        const row = await prisma.invoiceLineItem.create({
          data: {
            invoiceId,
            lineNumber: i + 1,
            description,
            poNumber: linePo,
            quantity,
            unit,
            unitRate,
            lineTotal,
            // Derived from what is true right now: no order, no ticket, no
            // rate. If the pass below fails, that is what the line should
            // still say — a line nothing has looked at must never be
            // indistinguishable from one that cleared every check.
            flag: deriveLineItemFlag({
              hasOrder: false,
              ticketCount: 0,
              hasQuantityDiscrepancy: false,
              hasRateDiscrepancy: false,
              hasAgreedRate: false,
              rateUnitMismatch: false,
            }),
          },
          select: { id: true },
        });

        created.push({ id: row.id, description });
      }

      // Pass two: the engine decides, and writes both its verdict and the
      // line's own columns from that one decision.
      //
      // This used to be a second matcher living here, comparing product names
      // at a 0.6 similarity score or on a substring — which makes "A Gravel"
      // and "B Gravel" the same product, and "3/4 clear" the same as "3/4
      // crusher run". It wrote `matchedOrderId`, `negotiatedRate` and the flag
      // that the invoice screens show, and then the engine wrote a verdict that
      // could say the opposite about the same line.
      const { matchInvoiceLineById } = await import('../matching/matching.service.js');
      for (const line of created) {
        try {
          await matchInvoiceLineById(line.id);
        } catch (matchError) {
          // Matching is advisory: a failure here must not undo an extraction
          // that succeeded. The line keeps its unchecked flag and shows up on
          // the desk as needing a person, which is the truth.
          console.error(
            `[Matching] Could not evaluate line "${line.description}" of invoice ${invoiceId}:`,
            matchError
          );
        }
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

      // The verdicts were written in pass two above, where their conclusions
      // were also projected onto the line columns. Running the engine a second
      // time here would only overwrite them with the same answer.

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

  /**
   * Marks an invoice checked and payable.
   *
   * This is where money is committed, so it is where the evidence has to be
   * consulted. Until now it flipped the status with no reference to the match
   * verdicts at all — every check the engine ran, and every discrepancy it
   * found, could be bypassed by clicking Verify. That made the whole thing
   * decorative at the only moment it mattered.
   *
   * A line that matched cleanly and that nobody has ruled on is confirmed here,
   * attributed to the verifier, so its tickets are claimed and cannot pay a
   * second invoice. A line with an unresolved problem stops the verification
   * and says which one.
   */
  async verifyInvoice(id: string, userId: string) {
    const lines = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: id },
      select: {
        id: true,
        lineNumber: true,
        matchResult: { select: { id: true, status: true, resolution: true } },
      },
      orderBy: { lineNumber: 'asc' },
    });

    // A line nothing has evaluated is not a pass.
    //
    // Matching is advisory on purpose: it runs inside a try/catch during import
    // so that a matching failure cannot undo a good extraction. The cost of
    // that choice is that "no verdict" usually means the engine errored — which
    // is exactly the case where nothing has been checked at all. Verifying such
    // a line would commit money against no evidence, and because claims are
    // only written when a verdict is resolved, it would also leave that line's
    // tickets unspent and free to pay a second invoice. Re-running the check is
    // cheap; paying twice is not.
    const unchecked = lines.filter((line) => !line.matchResult);

    if (unchecked.length > 0) {
      const numbers = unchecked.map((line) => line.lineNumber).join(', ');
      throw Object.assign(
        new Error(
          `Line ${numbers} ${unchecked.length === 1 ? 'has' : 'have'} not been checked against ` +
            'any order yet. Re-run the check on this invoice, then settle whatever it finds.'
        ),
        { status: 409 }
      );
    }

    const unresolved = lines.filter(
      (line) => !line.matchResult!.resolution && line.matchResult!.status !== 'MATCHED'
    );

    if (unresolved.length > 0) {
      const numbers = unresolved.map((line) => line.lineNumber).join(', ');
      throw Object.assign(
        new Error(
          `Line ${numbers} ${unresolved.length === 1 ? 'has an unresolved finding' : 'have unresolved findings'}. ` +
            'Settle them on the verification desk before verifying this invoice.'
        ),
        { status: 409 }
      );
    }

    // Clean lines nobody has ruled on are confirmed as part of verifying, so
    // that verifying an invoice really does spend its tickets.
    const toConfirm = lines.filter(
      (line) => line.matchResult && !line.matchResult.resolution && line.matchResult.status === 'MATCHED'
    );

    if (toConfirm.length > 0) {
      const { resolveMatchResult } = await import('../matching/resolveMatch.js');
      for (const line of toConfirm) {
        const outcome = await resolveMatchResult({
          matchResultId: line.matchResult!.id,
          resolution: 'CONFIRMED',
          note: 'Confirmed as part of verifying this invoice.',
          userId,
        });
        if (!outcome.ok) {
          throw Object.assign(
            new Error(
              `Line ${line.lineNumber} could not be confirmed: ` +
                ('detail' in outcome ? outcome.detail : outcome.code)
            ),
            { status: 409 }
          );
        }
      }
    }

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

  /**
   * Attaches tickets to a line by hand.
   *
   * This predates the matching engine and stays because the desk still needs a
   * way to say "these are the loads" when the engine cannot work it out. It is
   * not a payment decision, so it deliberately writes no claim — a load is
   * spent only when somebody resolves a verdict.
   *
   * What it must not do is quietly attach a load another invoice has already
   * been paid for. The engine would not be fooled (it gathers tickets by PO,
   * not through this link), but the person reading the line would be: the
   * NO_TICKET flag clears and the line looks backed.
   *
   * Note that this link lasts until the line is next evaluated. The engine now
   * writes `matchedTickets` from the loads its verdict actually counted, so a
   * recompute — a Spruce import, a ticket read, a resolution on the same PO —
   * replaces what was set here. Settling the verdict on the desk is what makes
   * a decision stick; this is a working note until then.
   */
  async linkTicketsToLineItem(lineItemId: string, ticketIds: string[], userId: string) {
    const claimed = await prisma.ticketClaim.findMany({
      where: { ticketId: { in: ticketIds }, invoiceLineId: { not: lineItemId } },
      select: {
        ticket: { select: { ticketNumber: true } },
        invoiceLine: {
          select: { lineNumber: true, invoice: { select: { invoiceNumber: true } } },
        },
      },
    });

    if (claimed.length > 0) {
      const where = claimed
        .map((claim) => {
          const ticket = claim.ticket.ticketNumber ?? 'without a number';
          return `${ticket} (paid on ${claim.invoiceLine.invoice.invoiceNumber} line ${claim.invoiceLine.lineNumber})`;
        })
        .join('; ');
      throw Object.assign(
        new Error(
          `${claimed.length === 1 ? 'Ticket' : 'Tickets'} ${where}. ` +
            'Reopen that decision first if this line is the one that should be paid.'
        ),
        { status: 409 }
      );
    }

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

