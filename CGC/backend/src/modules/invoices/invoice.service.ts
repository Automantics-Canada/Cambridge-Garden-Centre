import { prisma } from '../../db/prisma.js';
import { compareTwoStrings } from 'string-similarity';
import { saveInvoiceImage } from '../../services/fileStorage.js';
import { extractInvoiceDocument } from '../../services/invoiceOcr.service.js';
import {
  buildInvoiceProvenance,
  summariseReviewReasons,
} from '../../services/documentExtraction/mergeExtraction.js';
import { EXTRACTION_PROVIDER } from '../../services/documentExtraction/types.js';
import type {
  InvoiceLineExtraction,
  ReviewIssue,
} from '../../services/documentExtraction/types.js';
import { isoDateToUtcDate } from '../../services/documentExtraction/validation.js';
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
 * Manual link and unlink handlers used to stamp a literal flag — `OK` on link,
 * `NO_ORDER` on unlink — which meant attaching an order cleared an unrelated
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

/**
 * The domain an invoice arrived from, used as a second, exact way to identify
 * the supplier when the letterhead could not be read.
 */
function emailDomainOf(emailFrom: string | null | undefined): string | null {
  if (!emailFrom) return null;
  const match = emailFrom.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Park an invoice whose extraction did not fully hold up.
 *
 * Deliberately touches nothing that carries money or meaning: no supplier, no
 * invoice number, no date, no total, and above all no line items. Whatever was
 * on the invoice before — including a correct version somebody had already
 * fixed by hand — is still there afterwards.
 *
 * What it does record is the OCR text and the full field-by-field candidate set,
 * so the review desk can show a person what was read and let them accept it.
 */
async function holdInvoiceForReview(params: {
  invoiceId: string;
  ocrJobId: string | null;
  ocrText: string;
  ocrConfidence: number;
  provenance: unknown;
  reviewReasons: string[];
  fallback: { model: string | null; used: boolean };
}) {
  const { invoiceId, ocrJobId, ocrText, ocrConfidence, provenance, reviewReasons, fallback } = params;

  const [updated] = await prisma.$transaction([
    prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        ocrRawText: ocrText,
        OcrJobStatus: OcrJobStatus.NEEDS_REVIEW,
      },
    }),
    ...(ocrJobId
      ? [
          prisma.ocrJob.update({
            where: { id: ocrJobId },
            data: {
              status: OcrJobStatus.NEEDS_REVIEW,
              finishedAt: new Date(),
              rawResponse: provenance as any,
              structuredProvider: EXTRACTION_PROVIDER,
              structuredModel: fallback.model,
              fallbackUsed: fallback.used,
              reviewReasons,
              extractionConfidence: ocrConfidence,
              // Not an error. Clearing this keeps the stuck-job report — which
              // reads errorMessage — free of documents that are merely waiting
              // on a person.
              errorMessage: null,
            },
          }),
        ]
      : []),
  ]);

  console.log(
    '[InvoiceService]',
    JSON.stringify({
      invoiceId,
      outcome: 'NEEDS_REVIEW',
      reasonCount: reviewReasons.length,
      fallbackUsed: fallback.used,
    })
  );

  return updated;
}

/** One invoice line, fully resolved and ready to write. */
interface ComputedInvoiceLine {
  lineNumber: number;
  description: string;
  poNumber: string | null;
  quantity: number;
  unit: string;
  unitRate: number;
  lineTotal: number;
  matchedOrderId: string | null;
  matchedTicketIds: string[];
  negotiatedRate: number | null;
  rateDiscrepancy: number | null;
  qtyDiscrepancy: number | null;
  approvedTotal: number | null;
  flag: LineItemFlag;
}

/**
 * Match every line against tickets, orders and agreed rates.
 *
 * Read-only, and run before the write transaction opens. The matching itself is
 * unchanged from before — the ticket-first quantity check, the unit guard on the
 * rate comparison, the two-percent tolerance — only the coercion in front of it
 * is gone. Every value arriving here has already been validated, so there is
 * nothing left to default.
 */
async function computeInvoiceLineMatches(params: {
  lines: InvoiceLineExtraction[];
  headerPo: string | null;
  supplierId: string;
  invoiceDate: Date;
}): Promise<ComputedInvoiceLine[]> {
  const { lines, headerPo, supplierId, invoiceDate } = params;

  const allRates = await prisma.negotiatedRate.findMany({
    where: {
      supplierId,
      effectiveFrom: { lte: invoiceDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: invoiceDate } }],
    },
  });

  const computed: ComputedInvoiceLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as InvoiceLineExtraction;

    const description = line.description.value as string;
    const quantity = line.quantity.value as number;
    const unit = line.unit.value as string;
    const unitRate = line.unitRate.value as number;
    const lineTotal = line.lineTotal.value as number;
    const linePo = line.poNumber.value ?? headerPo;

    const flags: LineItemFlag[] = [];
    let matchedOrderId: string | null = null;
    let matchedTicketIds: string[] = [];
    let negotiatedRateVal: number | null = null;
    let rateDiscrepancy: number | null = null;
    let qtyDiscrepancy: number | null = null;

    // --- MATCH 1: Invoice line to ticket ---
    // The ticket is the only independent record of what actually moved — the
    // supplier writes the invoice, but the contractor signs the ticket — so an
    // invoice billing more than the tickets account for is the single most
    // useful thing this system can catch.
    let ticketedQuantity: number | null = null;
    if (linePo) {
      const matchingTickets = await prisma.ticket.findMany({
        where: { poNumber: linePo, supplierId },
        select: { id: true, quantity: true, unit: true, material: true },
      });

      if (matchingTickets.length > 0) {
        matchedTicketIds = matchingTickets.map(ticket => ticket.id);

        // Only tickets recorded in the same unit as the invoice line can be
        // summed against it. Mixing tonnes and cubic yards into one total would
        // produce a confident, wrong number.
        const comparable = matchingTickets.filter(
          ticket => ticket.quantity !== null && compareUnits(unit, ticket.unit).comparable
        );

        if (comparable.length > 0) {
          ticketedQuantity = comparable.reduce((sum, ticket) => sum + Number(ticket.quantity), 0);
        }
      }
    }

    if (matchedTicketIds.length === 0) flags.push(LineItemFlag.NO_TICKET);

    // --- MATCH 2: Invoice line to order ---
    if (linePo) {
      const potentialOrders = await prisma.order.findMany({
        where: { poNumber: linePo, supplierId },
      });
      const orderMatch = potentialOrders.find(order =>
        stringsMatchFuzzy(order.product ?? '', description)
      );
      if (orderMatch) {
        matchedOrderId = orderMatch.id;
      } else {
        flags.push(LineItemFlag.NO_ORDER);
      }
    } else {
      flags.push(LineItemFlag.NO_ORDER);
    }

    // --- Quantity check ---
    // Signed tickets first, then the order: the order is what was asked for, the
    // tickets are what was received, and billing follows what was received.
    const expectedQuantity =
      ticketedQuantity !== null
        ? ticketedQuantity
        : matchedOrderId
        ? Number(
            (
              await prisma.order.findUnique({
                where: { id: matchedOrderId },
                select: { quantity: true },
              })
            )?.quantity ?? Number.NaN
          )
        : Number.NaN;

    if (Number.isFinite(expectedQuantity) && expectedQuantity !== 0) {
      const diff = quantity - expectedQuantity;
      const tolerance = Math.abs(expectedQuantity) * 0.02; // 2% either way
      if (Math.abs(diff) > tolerance) {
        flags.push(LineItemFlag.QTY_MISMATCH);
        qtyDiscrepancy = diff;
      }
    }

    // --- MATCH 3: Rate ---
    // An alias recorded for this supplier is an exact, human-confirmed answer
    // and always beats guessing at the product name.
    const aliasRate = await resolveRateByAlias(supplierId, description, allRates);
    const rateMatch = aliasRate ?? allRates.find(rate => stringsMatchFuzzy(rate.productName, description));

    if (!rateMatch) {
      flags.push(LineItemFlag.RATE_UNKNOWN);
    } else {
      // Both sides must be priced per the same unit before the numbers mean
      // anything. Without this, $8.10/tonne against $9.10/ton reads as a clean
      // ten percent overcharge that nobody committed.
      const units = compareUnits(unit, rateMatch.unit);
      if (!units.comparable) {
        flags.push(LineItemFlag.UNIT_MISMATCH);
      } else {
        negotiatedRateVal = Number(rateMatch.rate);
        const diff = unitRate - negotiatedRateVal;
        // Recorded in both directions: being under-billed is still a
        // discrepancy, and the correction tends to arrive later.
        if (Math.abs(diff) > 0.01) {
          flags.push(LineItemFlag.RATE_MISMATCH);
          rateDiscrepancy = diff;
        }
      }
    }

    let flag: LineItemFlag = LineItemFlag.OK;
    if (flags.length > 1) {
      flag = LineItemFlag.MULTIPLE_FLAGS;
    } else if (flags.length === 1) {
      flag = flags[0] as LineItemFlag;
    }

    computed.push({
      lineNumber: index + 1,
      description,
      poNumber: linePo,
      quantity,
      unit,
      unitRate,
      lineTotal,
      matchedOrderId,
      matchedTicketIds,
      negotiatedRate: negotiatedRateVal,
      rateDiscrepancy,
      qtyDiscrepancy,
      approvedTotal: negotiatedRateVal === null ? null : quantity * negotiatedRateVal,
      flag,
    });
  }

  return computed;
}

/**
 * The invoice-level total check.
 *
 * Only lines with an applicable agreed rate can be totalled. Lines without one
 * were previously counted at a rate of zero, so a single unpriced product
 * dragged the expected total far below the billed total and stamped a mismatch
 * on an invoice that was very likely correct — which, on a supplier who had just
 * introduced a product, fired on every invoice. A dispute note that is usually
 * wrong is one nobody reads, so with unpriced lines present the totals are
 * simply not comparable and the reason is recorded instead.
 */
function buildDisputeNote(lines: ComputedInvoiceLine[], billedTotal: number): string | null {
  if (lines.length === 0) return null;

  const unpriced = lines.filter(line => line.negotiatedRate === null);
  if (unpriced.length > 0) {
    return (
      `Total not checked: ${unpriced.length} of ${lines.length} line(s) have no ` +
      `applicable agreed rate (${unpriced.map(line => line.description).join('; ')}). ` +
      `Billed: $${billedTotal.toFixed(2)}. Add the missing rates, then reopen to re-check.`
    );
  }

  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * (line.negotiatedRate as number),
    0
  );
  // HST is Ontario's 13%. Hard-coded because every supplier here is
  // Ontario-registered; revisit if that stops being true.
  const withHst = subtotal * 1.13;

  if (Math.abs(withHst - billedTotal) <= 0.05) return null;

  return (
    `Total amount mismatch. Expected pay: $${withHst.toFixed(2)} ` +
    `(Subtotal: $${subtotal.toFixed(2)} + 13% HST). Billed: $${billedTotal.toFixed(2)}.`
  );
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
        totalAmount: null,
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

  /**
   * Read an invoice document and, when the read holds up, post it.
   *
   * The shape of this is the point. It runs in three phases:
   *
   *   1. read and validate — nothing is written;
   *   2. decide — a document with any unresolved field stops here and is held
   *      for a person, with the invoice left exactly as it was;
   *   3. write — the invoice header and the complete set of lines are replaced
   *      together, inside one transaction.
   *
   * Previously all three were interleaved. The header was updated first, then
   * the lines were deleted, then each line was recreated one at a time in its
   * own statement. A failure anywhere in that sequence — a malformed line, a
   * dropped connection — left the invoice carrying new header totals with its
   * lines partly or entirely gone, and nothing recorded that it had happened.
   * Worse, missing values were coerced on the way in (`Number(x) || 0`, a unit
   * defaulted to "ea", a description defaulted to "Unknown Item"), so an invoice
   * that could not be read at all still came out looking like a complete,
   * zero-priced one.
   */
  async processInvoiceOcr(invoiceId: string, claimedJobId?: string) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        ocrJobs: {
          ...(claimedJobId ? { where: { id: claimedJobId } } : {}),
          orderBy: { startedAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!invoice) throw new Error('Invoice not found');

    const ocrJob = invoice.ocrJobs[0];
    if (!ocrJob) throw new Error('No OCR job found for invoice');

    if (claimedJobId) {
      if (ocrJob.status !== OcrJobStatus.PROCESSING) {
        return prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
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
        return prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      }
    }

    try {
      // ---- Phase 1: read. Nothing below this line writes anything. ----
      const outcome = await extractInvoiceDocument({
        fileUrl: invoice.fileUrl,
        jobId: ocrJob.id,
      });

      const issues: ReviewIssue[] = [...outcome.issues];

      // The supplier is *found*, never created and never fuzzily attached.
      // See SupplierService.resolveSupplierForOcr for why.
      const { SupplierService } = await import('../supplier/supplier.service.js');
      const resolution = await SupplierService.resolveSupplierForOcr(
        outcome.fields.supplierName.value,
        { emailDomain: emailDomainOf(invoice.emailFrom) }
      );

      if (!resolution.supplier) {
        issues.push({
          field: 'supplierName',
          code: 'UNRESOLVED_SUPPLIER',
          message: resolution.reason ?? 'Supplier could not be matched to a recorded supplier',
        });
      }

      const supplierId = resolution.supplier?.id ?? invoice.supplierId;
      const complete = issues.length === 0;

      const provenance = {
        ...buildInvoiceProvenance({ ...outcome, issues, complete }),
        supplierMatch: {
          method: resolution.method,
          suggestion: resolution.suggestion,
        },
      };
      const reviewReasons = summariseReviewReasons(issues);

      // ---- Phase 2: decide. ----
      if (!complete) {
        return await holdInvoiceForReview({
          invoiceId,
          ocrJobId: ocrJob.id,
          ocrText: outcome.ocrText,
          ocrConfidence: outcome.ocrConfidence,
          provenance,
          reviewReasons,
          fallback: outcome.fallback,
        });
      }

      // ---- Phase 3: write. ----
      // Every read the matching needs happens here, before the transaction
      // opens, so the transaction holds locks only for as long as the writes
      // take.
      const invoiceDate = isoDateToUtcDate(outcome.fields.invoiceDate.value as string);
      const totalAmount = outcome.fields.total.value as number;

      const computedLines = await computeInvoiceLineMatches({
        lines: outcome.fields.lines,
        headerPo: outcome.fields.poNumber.value,
        supplierId,
        invoiceDate,
      });

      const disputeNote = buildDisputeNote(computedLines, totalAmount);

      const updatedInvoice = await prisma.$transaction(
        async tx => {
          const written = await tx.invoice.update({
            where: { id: invoiceId },
            data: {
              // `Invoice.supplier` is a required relation, so Prisma exposes only
              // the nested form here — assigning the `supplierId` scalar on an
              // update is rejected at runtime, not at compile time.
              supplier: { connect: { id: supplierId } },
              invoiceNumber: outcome.fields.invoiceNumber.value as string,
              invoiceDate,
              totalAmount,
              currency: 'CAD',
              // The OCR text, not a serialised provider response. This column is
              // read by people and by the search; it used to hold a JSON dump of
              // the entire Textract payload plus the model's output.
              ocrRawText: outcome.ocrText,
              disputeNote,
              OcrJobStatus: OcrJobStatus.COMPLETED,
            },
          });

          // Replacing the lines wholesale is correct — the document is the
          // authority on what it charges for — but the delete and the recreate
          // have to succeed or fail together, which is what this transaction is
          // for.
          await tx.invoiceLineItem.deleteMany({ where: { invoiceId } });

          for (const line of computedLines) {
            await tx.invoiceLineItem.create({
              data: {
                invoiceId,
                lineNumber: line.lineNumber,
                description: line.description,
                poNumber: line.poNumber,
                quantity: line.quantity,
                unit: line.unit,
                unitRate: line.unitRate,
                lineTotal: line.lineTotal,
                matchedOrderId: line.matchedOrderId,
                matchedTickets: { connect: line.matchedTicketIds.map(id => ({ id })) },
                negotiatedRate: line.negotiatedRate,
                rateDiscrepancy: line.rateDiscrepancy,
                qtyDiscrepancy: line.qtyDiscrepancy,
                approvedTotal: line.approvedTotal,
                flag: line.flag,
              },
            });
          }

          await tx.ocrJob.update({
            where: { id: ocrJob.id },
            data: {
              status: OcrJobStatus.COMPLETED,
              finishedAt: new Date(),
              rawResponse: provenance as any,
              structuredProvider: EXTRACTION_PROVIDER,
              structuredModel: outcome.fallback.model,
              fallbackUsed: outcome.fallback.used,
              reviewReasons: [],
              extractionConfidence: outcome.ocrConfidence,
              errorMessage: null,
            },
          });

          return written;
        },
        // Line-by-line creates on a long invoice can outrun the 5s default.
        { timeout: 30_000 }
      );

      return updatedInvoice;
    } catch (error: any) {
      // A throw here means no usable candidate was produced at all — the file
      // was unreachable, or Textract found no text. That is FAILED, and the
      // worker's retry/backoff applies. A document that merely could not be
      // read *confidently* never reaches this path; it is held for review above.
      await prisma.ocrJob.update({
        where: { id: ocrJob.id },
        data: {
          status: OcrJobStatus.FAILED,
          errorMessage: error?.message ?? 'Unknown error',
          finishedAt: new Date(),
        },
      });
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
    // outright, which also wiped a live RATE_MISMATCH or QTY_MISMATCH — so
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

