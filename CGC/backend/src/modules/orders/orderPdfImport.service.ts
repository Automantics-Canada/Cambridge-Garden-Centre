import { prisma } from '../../db/prisma.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { orderEventEmitter, OrderEvents } from './order.events.js';
import { buildSpruceLineKey } from './orderImportKey.js';
import { parseSpruceDate } from '../../lib/spruceDate.js';
import { SprucePdfError } from '../../lib/pdf/pdfWords.js';
import { parseSprucePdf } from './spruce/parseSprucePdf.js';
import {
  reconcileDocumentLines,
  type ExistingLine,
} from './spruce/reconcileSpruceDocument.js';
import type { ParsedSpruceRow, SpruceReportType } from './spruce/spruceReportTypes.js';

export interface ImportSummary {
  created: number;
  updated: number;
  /** Paired rows whose line content already matched the report exactly. */
  unchanged: number;
  /**
   * Stored lines this report does not mention. Never deleted: they may carry
   * deliveries, tickets or invoices that outlive the report.
   */
  absent: number;
  /** Documents refused because a line could not be placed without guessing. */
  conflicts: number;
  skipped: number;
  errors: Array<{ rowNumber: number; error: string }>;
}

/** A document refused before anything was written; its siblings still import. */
class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

/**
 * What each report may overwrite once a document already exists.
 *
 * The reports are not equivalent witnesses. The Customer Order Summary and
 * the delivery run sheet name the customer outright; the Item Tracking report
 * prints "Cash Sales" for walk-in trade where the other two print the person
 * behind it, so letting it write `customerName` replaced real names with a
 * counter word. Its authority is the enrichment only it carries: PO, vendor
 * and shipping address. Line content — what was ordered, how much — is every
 * report's to refresh, since reconciliation pairs by item identity first.
 */
const REPORT_UPDATES_CUSTOMER: Record<SpruceReportType, boolean> = {
  ORDER_SUMMARY: true,
  DELIVERY: true,
  ITEM_TRACKING: false,
};

/**
 * Unit of measure for a line, read from its description.
 *
 * This was `descLower.includes('mt')` and `includes('cy')`, which match inside
 * ordinary words — "Fancy Mulch" contains "cy", so it was priced by the cubic
 * yard. Matching is now on whole tokens, and an unrecognised description keeps
 * the previous 'EA' default rather than inventing a measure.
 *
 * Only used for the one report that prints no unit column; the other two say
 * what the unit is and are believed over this.
 */
export function inferUnitFromDescription(description: string): string {
  const tokens = description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  if (tokens.some(t => t === 'mt' || t === 'tonne' || t === 'tonnes')) return 'MT';
  if (tokens.some(t => t === 'cy' || t === 'yd' || t === 'yds')) return 'CY';
  if (tokens.some(t => t === 'skid' || t === 'skids' || t === 'pallet' || t === 'pallets')) return 'Skid';
  if (tokens.some(t => t === 'ton' || t === 'tons')) return 'TON';

  return 'EA';
}

/** Just the model the vendor lookup needs; both the client and a transaction satisfy it. */
type VendorLookupClient = Pick<Prisma.TransactionClient, 'supplierSpruceVendor'>;

/**
 * Resolves the vendor codes on the report to suppliers.
 *
 * The item-tracking report names vendors as Spruce codes (`BESTWAYS01`,
 * `UNILOCKL01`), which match no supplier's stored name — matching one against
 * the other was a guess that decided which negotiated rates an invoice is
 * checked against. Resolution now goes through `SupplierSpruceVendor`, which a
 * person records once and which is exact thereafter. Anything unmapped stays
 * null and is reported, never guessed.
 */
async function buildVendorIndex(client: VendorLookupClient, rows: ParsedSpruceRow[]): Promise<Map<string, string>> {
  const codes = [...new Set(
    rows.map(row => row.vendorName?.trim().toUpperCase()).filter(Boolean) as string[]
  )];
  const index = new Map<string, string>();
  if (codes.length === 0) return index;

  const mappings = await client.supplierSpruceVendor.findMany({
    where: { code: { in: codes }, active: true },
    select: { code: true, supplierId: true, supplier: { select: { active: true } } },
  });

  for (const mapping of mappings) {
    if (mapping.supplier.active) index.set(mapping.code, mapping.supplierId);
  }

  return index;
}

interface PreparedRow {
  row: ParsedSpruceRow;
  orderDate: Date;
  deliveryDate: Date | null;
  unit: string;
  supplierId: string | null;
}

/**
 * Resolves everything the report leaves as text before any write happens.
 *
 * An order date that is missing or unreadable refuses the whole document: the
 * old fallback stamped "today" on the row, and an order dated today instead of
 * August looks healthy on every screen until a bill goes unpaid against it.
 */
function prepareRows(rows: ParsedSpruceRow[], vendorIndex: Map<string, string>): PreparedRow[] {
  return rows.map(row => {
    const orderDate = parseSpruceDate(row.orderDateRaw);
    if (!orderDate) {
      throw new DocumentError(
        `Page ${row.source.page}, row ${row.source.row}: ` +
        (row.orderDateRaw
          ? `unreadable order date "${row.orderDateRaw}"`
          : 'no order date on the report') +
        '; nothing for this document was written.'
      );
    }

    if (row.deliveryDateRaw && !parseSpruceDate(row.deliveryDateRaw)) {
      throw new DocumentError(
        `Page ${row.source.page}, row ${row.source.row}: unreadable delivery date "${row.deliveryDateRaw}".`
      );
    }

    return {
      row,
      orderDate,
      deliveryDate: parseSpruceDate(row.deliveryDateRaw),
      unit: row.unit ?? inferUnitFromDescription(row.product),
      supplierId: row.vendorName
        ? vendorIndex.get(row.vendorName.trim().toUpperCase()) ?? null
        : null,
    };
  });
}

/**
 * The document header fields each report knows a different subset of.
 *
 * First-wins per field, so one document's rows contribute whichever of them
 * carries each fact. A later import widens the record; nothing here erases.
 */
function documentHeader(prepared: PreparedRow[], updatesCustomer: boolean) {
  const first = prepared[0]!;
  const firstDeliveryDate = prepared.map(p => p.deliveryDate).find(d => d !== null);
  const firstPoNumber = prepared.map(p => p.row.poNumber).find(po => po);
  const firstShippingAddress = prepared.map(p => p.row.shippingAddress).find(a => a?.trim());

  return {
    ...(updatesCustomer ? { customerName: first.row.customerName } : {}),
    orderDate: first.orderDate,
    ...(firstDeliveryDate ? { deliveryDate: firstDeliveryDate } : {}),
    ...(firstPoNumber ? { poNumber: firstPoNumber } : {}),
    ...(firstShippingAddress ? { shippingAddress: firstShippingAddress } : {}),
  };
}

type ProgressEvent = { action: 'created' | 'updated'; order: unknown };

interface DocumentResult {
  created: number;
  updated: number;
  unchanged: number;
  absent: number;
  events: ProgressEvent[];
}

/**
 * Imports one document inside its own transaction.
 *
 * Either the whole document lands or none of it does: a failure halfway
 * through used to leave some rows written and others not, while the summary
 * counted both as success.
 *
 * Existing rows are found by reconciliation — item code where the report
 * prints one, description otherwise — and never by place in the document,
 * because the three reports print one document's lines in different orders.
 * Rows imported by the Textract-era importer are adopted here too: anything
 * keyed to this document number joins the same reconciliation instead of
 * gaining duplicates beside it.
 */
export async function importDocument(
  tx: Prisma.TransactionClient,
  documentNumber: string,
  rows: ParsedSpruceRow[],
  vendorIndex: Map<string, string>,
  reportType: SpruceReportType
): Promise<DocumentResult> {
  const prepared = prepareRows(rows, vendorIndex);

  const document = await tx.orderDocument.upsert({
    where: { documentNumber },
    update: documentHeader(prepared, REPORT_UPDATES_CUSTOMER[reportType]),
    create: {
      documentNumber,
      // A document being created has no customer to protect.
      customerName: prepared[0]!.row.customerName,
      ...documentHeader(prepared, true),
    },
    select: { id: true },
  });

  // Every row that belongs to this document, under either key shape: rows this
  // importer wrote (`documentId` set) and rows the Textract-era importer left
  // keyed by PDF position (`documentId` null, document number in the key).
  // Adopting them here is what makes a re-import update rather than duplicate.
  const storedLines = await tx.order.findMany({
    where: {
      OR: [
        { documentId: document.id },
        { documentId: null, spruceOrderId: { startsWith: `${documentNumber}-` } },
        { documentId: null, spruceOrderId: documentNumber },
      ],
    },
    select: {
      id: true,
      product: true,
      quantity: true,
      unit: true,
      spruceItemNumber: true,
      lineNumber: true,
      poNumber: true,
      hasInvoice: true,
      deliveryStatus: true,
      driverId: true,
      _count: {
        select: {
          deliveries: true,
          lineItems: true,
          tickets: true,
          ticketMatches: true,
        },
      },
    },
  });

  const existingLines: ExistingLine[] = storedLines.map(line => ({
    id: line.id,
    product: line.product,
    quantity: line.quantity,
    unit: line.unit,
    spruceItemNumber: line.spruceItemNumber,
    lineNumber: line.lineNumber,
    poNumber: line.poNumber,
    hasOperationalLinks:
      line.hasInvoice ||
      line.driverId !== null ||
      line.deliveryStatus !== 'NOT_STARTED' ||
      line._count.deliveries > 0 ||
      line._count.lineItems > 0 ||
      line._count.tickets > 0 ||
      line._count.ticketMatches > 0,
  }));

  const plan = reconcileDocumentLines(rows, existingLines);

  // A conflict means the report cannot safely be paired with what is stored.
  // Writing the unambiguous lines and skipping the ambiguous ones would leave
  // the document half-refreshed against itself, so the whole document waits.
  if (plan.conflicts.length > 0) {
    const first = plan.conflicts[0]!;
    throw new DocumentError(
      `${plan.conflicts.length} line(s) could not be matched safely ` +
        `(page ${rows[first.incomingIndex]?.source.page}, row ${rows[first.incomingIndex]?.source.row}: ` +
        `${first.reason}). Nothing for this document was written.`
    );
  }

  // New lines number on from the highest existing position, so their
  // `spruceOrderId` keys never collide with an earlier import's.
  let nextLineNumber = existingLines.reduce(
    (max, line) => Math.max(max, line.lineNumber ?? 0),
    0
  );

  const result: DocumentResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    absent: plan.absentIds.length,
    events: [],
  };

  for (const paired of plan.paired) {
    const p = prepared[paired.incomingIndex]!;
    const source = p.row;

    // Source-owned fields refresh on every paired row, changed or not: the
    // report is the authority for what was ordered and when. Workflow state —
    // hasInvoice, invoiceNumber, deliveryStatus, driver, priority, buyerType —
    // is deliberately absent: no report may reset it.
    const data: Prisma.OrderUncheckedUpdateInput = {
      ...('patch' in paired ? paired.patch : {}),
      ...(REPORT_UPDATES_CUSTOMER[reportType] ? { customerName: source.customerName } : {}),
      orderDate: p.orderDate,
      ...(p.deliveryDate ? { deliveryDate: p.deliveryDate } : {}),
      ...(source.poNumber ? { poNumber: source.poNumber } : {}),
      ...(p.supplierId ? { supplierId: p.supplierId } : {}),
      documentId: document.id,
    };

    const written = await tx.order.update({ where: { id: paired.id }, data });
    result.events.push({ action: 'updated', order: written });
    if (paired.kind === 'update') result.updated++;
    else result.unchanged++;
  }

  for (const index of plan.createIndices) {
    const p = prepared[index]!;
    nextLineNumber += 1;

    const createdOrder = await tx.order.create({
      data: {
        spruceOrderId: buildSpruceLineKey(documentNumber, nextLineNumber),
        documentId: document.id,
        lineNumber: nextLineNumber,
        ...(p.row.itemNumber ? { spruceItemNumber: p.row.itemNumber.trim() } : {}),
        poNumber: p.row.poNumber ?? null,
        customerName: p.row.customerName,
        supplierId: p.supplierId,
        product: p.row.product,
        quantity: p.row.quantity.toString(),
        unit: p.unit,
        orderDate: p.orderDate,
        deliveryDate: p.deliveryDate,
        hasInvoice: false,
      },
    });
    result.events.push({ action: 'created', order: createdOrder });
    result.created++;
  }

  return result;
}

export const OrderPdfImportService = {
  /**
   * Imports a Spruce order report.
   *
   * The report is read from its own text layer rather than recognised from an
   * image of it — these are digital PDFs whose every figure already carries
   * its position, and inferring a table from pixels was what bound
   * descriptions to the wrong item codes.
   *
   * Documents are written one transaction each, so a single bad document is
   * reported against its own number and the rest of the upload still lands.
   */
  async importFromPdf(buffer: Buffer, jobId: string): Promise<ImportSummary> {
    return this.importWithClient(prisma, buffer, jobId);
  },

  /** `importFromPdf` against an injected client, so persistence is testable. */
  async importWithClient(
    client: PrismaClient,
    buffer: Buffer,
    jobId: string
  ): Promise<ImportSummary> {
    return this.applyReport(client, await parseSprucePdf(buffer), jobId);
  },

  /**
   * Writes an already-parsed report against an injected client.
   *
   * Separated from parsing because pdf2json rejects machine-generated PDFs,
   * so persistence tests drive it with page objects read through the same
   * parsers production uses.
   */
  async applyReport(
    client: PrismaClient,
    report: Awaited<ReturnType<typeof parseSprucePdf>>,
    jobId: string
  ): Promise<ImportSummary> {
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let absent = 0;
    let conflicts = 0;
    let skipped = 0;
    const errors: ImportSummary['errors'] = [];

    try {
      console.log(
        `[OrderPdfImport] Read ${report.rows.length} lines from a ${report.type} report ` +
          `(${report.unreadable.length} unreadable).`
      );

      // Reported rather than dropped: a silently skipped line is how an order
      // goes missing without anyone noticing it went.
      for (const row of report.unreadable) {
        skipped++;
        errors.push({ rowNumber: row.row, error: `Page ${row.page}, row ${row.row}: ${row.reason}` });
      }

      const vendorIndex = await buildVendorIndex(client, report.rows);

      // Vendor codes with no recorded mapping are named once each, so the fix
      // is one mapping entry rather than a hunt through unlinked orders.
      const unmapped = new Set<string>();
      for (const row of report.rows) {
        const code = row.vendorName?.trim().toUpperCase();
        if (code && !vendorIndex.has(code)) unmapped.add(code);
      }
      for (const code of unmapped) {
        errors.push({
          rowNumber: report.rows.find(r => r.vendorName?.trim().toUpperCase() === code)?.source.row ?? 0,
          error: `Vendor code "${code}" has no supplier mapping; its lines were imported unlinked. ` +
            'Record it with npm run vendors:add.',
        });
      }

      // Rows grouped per document, in report order.
      const documents = new Map<string, ParsedSpruceRow[]>();
      for (const row of report.rows) {
        const group = documents.get(row.documentNumber);
        if (group) group.push(row);
        else documents.set(row.documentNumber, [row]);
      }

      for (const [documentNumber, rows] of documents) {
        try {
          const result = await client.$transaction(tx =>
            importDocument(tx, documentNumber, rows, vendorIndex, report.type)
          );

          created += result.created;
          updated += result.updated;
          unchanged += result.unchanged;
          absent += result.absent;

          // Emitted only once the transaction has committed, so the stream
          // never announces a row that a rollback then took back.
          for (const event of result.events) {
            orderEventEmitter.emit(OrderEvents.PDF_IMPORT_PROGRESS, { jobId, ...event });
          }
        } catch (e: any) {
          skipped += rows.length;
          if (e instanceof DocumentError) conflicts++;
          const reason =
            e instanceof DocumentError || e instanceof SprucePdfError
              ? e.message
              : 'A server operation failed. Retry this report; if it keeps failing, ' +
                'contact an administrator with this document number.';
          console.error(`[OrderPdfImport] Document ${documentNumber} failed:`, e);
          errors.push({
            rowNumber: rows[0]?.source.row ?? 0,
            error: `Document ${documentNumber}: ${reason}`,
          });
        }
      }
    } catch (err: any) {
      // Parser errors are written for an operator. Unexpected exceptions can
      // contain SQL, local paths or provider internals, so keep those in the
      // server log and return only a safe recovery step to the browser.
      const message =
        err instanceof SprucePdfError
          ? err.message
          : 'The import failed unexpectedly. Retry the report; if it keeps failing, ' +
            'contact an administrator with the job ID.';

      console.error('[OrderPdfImport] Import failed:', err);
      errors.push({ rowNumber: 0, error: message });
      return { created, updated, unchanged, absent, conflicts, skipped, errors };
    }

    const summary = { created, updated, unchanged, absent, conflicts, skipped, errors };
    return summary;
  },
};
