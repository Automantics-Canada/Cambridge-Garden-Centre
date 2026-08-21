import { prisma } from '../../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { orderEventEmitter, OrderEvents } from './order.events.js';
import { buildSpruceLineKey } from './orderImportKey.js';
import { parseSpruceDate } from '../../lib/spruceDate.js';
import { SprucePdfError } from '../../lib/pdf/pdfWords.js';
import { parseSprucePdf } from './spruce/parseSprucePdf.js';
import type { ParsedSpruceRow } from './spruce/spruceReportTypes.js';

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ rowNumber: number; error: string }>;
}

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

/**
 * Finds or creates the OrderDocument for a Spruce document number.
 *
 * The document number is the join key between the reports, so it is created on
 * first sight and its header fields are refreshed from whichever report
 * supplies them. `poNumber` and `shippingAddress` are only ever widened — each
 * report knows a different subset, and a later import that lacks a field must
 * not erase what an earlier one established.
 */
async function upsertOrderDocument(input: {
  documentNumber: string;
  customerName: string;
  poNumber: string | null;
  orderDate: Date;
  deliveryDate: Date | null;
  shippingAddress: string | null;
}) {
  const { documentNumber, customerName, poNumber, orderDate, deliveryDate, shippingAddress } = input;

  return prisma.orderDocument.upsert({
    where: { documentNumber },
    update: {
      customerName,
      orderDate,
      ...(deliveryDate ? { deliveryDate } : {}),
      ...(poNumber ? { poNumber } : {}),
      ...(shippingAddress ? { shippingAddress } : {}),
    },
    create: {
      documentNumber,
      customerName,
      poNumber,
      orderDate,
      deliveryDate,
      shippingAddress,
    },
    select: { id: true },
  });
}

/**
 * Resolves a vendor name to a supplier, by exact name only.
 *
 * Supplier used to be inferred by asking whether any supplier's name
 * *contained* the customer's, which is backwards twice over: the customer buys
 * from the yard, the supplier sells to it, and a short name matches half the
 * table by substring. A wrong supplier decides which negotiated rates an
 * invoice is checked against, so a guess here costs real money.
 *
 * The item-tracking report names the vendor outright, so that name is matched
 * whole or not at all. Anything less certain stays null and waits for a person.
 */
async function buildVendorIndex(rows: ParsedSpruceRow[]): Promise<Map<string, string>> {
  const names = new Set(rows.map(row => row.vendorName?.trim().toLowerCase()).filter(Boolean) as string[]);
  if (names.size === 0) return new Map();

  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true } });

  const index = new Map<string, string>();
  for (const supplier of suppliers) {
    const key = supplier.name.trim().toLowerCase();
    if (names.has(key)) index.set(key, supplier.id);
  }

  return index;
}

export const OrderPdfImportService = {
  /**
   * Imports a Spruce order report.
   *
   * The report is read from its own text layer rather than recognised from an
   * image of it. See `spruce/parseSprucePdf` for why: these are digital PDFs
   * whose every figure already carries its position, and inferring a table from
   * pixels was what bound descriptions to the wrong item codes.
   *
   * Rows are written one at a time so that a single bad row is reported against
   * its own line and the rest of the import still lands.
   */
  async importFromPdf(buffer: Buffer, jobId: string): Promise<ImportSummary> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: ImportSummary['errors'] = [];

    try {
      const report = await parseSprucePdf(buffer);
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

      const vendorIndex = await buildVendorIndex(report.rows);

      // Line numbers run per document across the whole upload, so a document
      // whose lines span a page break keeps numbering continuously instead of
      // restarting at 1 and colliding with its own earlier lines.
      const lineCounters = new Map<string, number>();

      for (const row of report.rows) {
        const { page, row: rowNumber } = row.source;

        const orderDate = parseSpruceDate(row.orderDateRaw) ?? new Date();
        if (row.orderDateRaw && !parseSpruceDate(row.orderDateRaw)) {
          errors.push({
            rowNumber,
            error: `Page ${page}, row ${rowNumber}: unreadable order date "${row.orderDateRaw}"; used today's date`,
          });
        }

        const deliveryDate = parseSpruceDate(row.deliveryDateRaw);
        if (row.deliveryDateRaw && !deliveryDate) {
          errors.push({
            rowNumber,
            error: `Page ${page}, row ${rowNumber}: unreadable delivery date "${row.deliveryDateRaw}"`,
          });
        }

        // The reports that print a unit are believed; only the one that does
        // not falls back to reading the description.
        const unit = row.unit ?? inferUnitFromDescription(row.product);
        const supplierId = row.vendorName
          ? vendorIndex.get(row.vendorName.trim().toLowerCase()) ?? null
          : null;

        const data: Prisma.OrderUncheckedCreateInput = {
          spruceOrderId: '', // replaced below, once the line number is known
          poNumber: row.poNumber ?? null,
          customerName: row.customerName,
          supplierId,
          // buyerType is deliberately not set: the report does not say, and
          // stamping CONTRACTOR on every row hid the B2C side of the business
          // entirely. The column's default applies instead, which records it as
          // an assumption rather than something read off the page. See the
          // schema comment on Order.buyerType.
          product: row.product,
          quantity: row.quantity.toString(),
          unit,
          orderDate,
          deliveryDate,
          hasInvoice: false,
        };

        try {
          const document = await upsertOrderDocument({
            documentNumber: row.documentNumber,
            customerName: row.customerName,
            poNumber: row.poNumber ?? null,
            orderDate,
            deliveryDate,
            shippingAddress: row.shippingAddress ?? null,
          });

          const lineNumber = (lineCounters.get(document.id) ?? 0) + 1;
          lineCounters.set(document.id, lineNumber);

          data.spruceOrderId = buildSpruceLineKey(row.documentNumber, lineNumber);

          // Identity is the line's place within its document, not its place on
          // the page. The page-and-row keys the OCR importer wrote cannot be
          // reproduced here — there are no OCR table blocks to count — so a
          // re-import finds its earlier rows by (document, line) and updates
          // them, rewriting the key as it goes.
          //
          // Matching on content instead was considered and rejected: a document
          // may legitimately carry the same product on two lines, and matching
          // by name would quietly merge them into one.
          const existing =
            (await prisma.order.findFirst({
              where: { documentId: document.id, lineNumber },
              select: { id: true },
            }))
            ?? (await prisma.order.findUnique({
              where: { spruceOrderId: data.spruceOrderId },
              select: { id: true },
            }));

          const payload = { ...data, documentId: document.id, lineNumber };

          if (existing) {
            const updatedObj = await prisma.order.update({ where: { id: existing.id }, data: payload });
            updated++;
            orderEventEmitter.emit(OrderEvents.PDF_IMPORT_PROGRESS, { jobId, action: 'updated', order: updatedObj });
          } else {
            const createdObj = await prisma.order.create({ data: payload });
            created++;
            orderEventEmitter.emit(OrderEvents.PDF_IMPORT_PROGRESS, { jobId, action: 'created', order: createdObj });
          }
        } catch (e: any) {
          skipped++;
          errors.push({
            rowNumber,
            error: `Page ${page}, row ${rowNumber}: ${e?.message || 'Database error'}`,
          });
        }
      }
    } catch (err: any) {
      // A SprucePdfError already says what to do about it; anything else is
      // reported as it stands.
      const message =
        err instanceof SprucePdfError ? err.message : `Critical error: ${err?.message ?? 'unknown'}`;

      console.error('[OrderPdfImport] Import failed:', err);
      errors.push({ rowNumber: 0, error: message });
      orderEventEmitter.emit(OrderEvents.PDF_IMPORT_ERROR, { jobId, error: message });
      return { created, updated, skipped, errors };
    }

    const summary = { created, updated, skipped, errors };
    orderEventEmitter.emit(OrderEvents.PDF_IMPORT_DONE, { jobId, summary });
    return summary;
  },
};
