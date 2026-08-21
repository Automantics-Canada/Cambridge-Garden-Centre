import { prisma } from '../../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { parseSprucePdf, REPORT_LABELS } from './spruce/parseSprucePdf.js';
import {
  reconcileDocumentLines,
  type ExistingLine,
} from './spruce/reconcileSpruceDocument.js';
import type { ParsedSpruceRow } from './spruce/spruceReportTypes.js';

/**
 * The second half of the Spruce two-report import.
 *
 * Only the Item Tracking report carries purchase orders, and it carries them
 * per line: a document may buy from two vendors under two POs, so a single
 * PO per document was wrong wherever the yard split an order. The merge is
 * therefore line-level — each parsed line is reconciled with its stored Order
 * by item identity, and only matched lines are written.
 *
 * The merge is deterministic and reviewable: parse, show what matches, then
 * write only when a person says so.
 */

export interface PoReportRow {
  documentNumber: string;
  /** Set only when every PO-bearing line agrees. Multi-PO documents use null. */
  poNumber: string | null;
  /** Every distinct PO printed for this document. */
  poNumbers: string[];
  pageNumber: number;
  rowNumber: number;
}

/** One Item Tracking line that carries a PO, kept at line granularity. */
export interface PoReportLine {
  documentNumber: string;
  poNumber: string;
  itemNumber?: string;
  product: string;
  quantity: number;
  unit?: string;
  /** Spruce's vendor code, e.g. `BESTWAYS01`. Resolved through SupplierSpruceVendor. */
  vendorCode?: string;
  pageNumber: number;
  rowNumber: number;
}

export interface PoMergeMatch {
  documentNumber: string;
  poNumber: string | null;
  poNumbers: string[];
  customerName: string;
  /** PO already on the document, when it differs from the incoming one. */
  existingPoNumber: string | null;
  lineCount: number;
}

export interface PoMergePreview {
  /** Documents that will gain a PO number they did not have. */
  toSet: PoMergeMatch[];
  /** Documents already carrying a different PO. Never written without intent. */
  conflicts: PoMergeMatch[];
  /** Documents already carrying exactly this PO. */
  unchanged: PoMergeMatch[];
  /** Documents whose individual lines legitimately carry more than one PO. */
  multiPo: PoMergeMatch[];
  /** Rows whose document number is not in the system. */
  unmatched: PoReportRow[];
  /** Vendor codes on this report with no recorded supplier mapping. */
  unmappedVendors: Array<{ code: string; documentNumbers: string[] }>;
  /** Rows the parser could not read a document number and PO from. */
  unreadable: Array<{ pageNumber: number; rowNumber: number; reason: string }>;
  /** PO-bearing report lines that cannot be placed onto exactly one stored row. */
  lineConflicts: Array<{ documentNumber: string; rowNumber: number; reason: string }>;
  lineMatches: number;
}

/**
 * Reads (document number, PO number) pairs out of the PO report.
 *
 * It prints one line per item, so a document with several items may repeat one
 * PO or legitimately carry several. The document summary records every PO;
 * the full lines remain canonical for the one-to-one apply. A document with
 * no PO and a report of the wrong kind are reported. A silently skipped row is
 * how a PO goes missing without anyone noticing it went.
 */
export async function parsePoReport(buffer: Buffer): Promise<{
  rows: PoReportRow[];
  lines: PoReportLine[];
  unreadable: PoMergePreview['unreadable'];
}> {
  const report = await parseSprucePdf(buffer);
  const unreadable: PoMergePreview['unreadable'] = [];

  if (report.type !== 'ITEM_TRACKING') {
    // Reporting this per row would bury the point under one entry per line.
    return {
      rows: [],
      lines: [],
      unreadable: [
        {
          pageNumber: 1,
          rowNumber: 0,
          reason:
            `This is the ${REPORT_LABELS[report.type]}, which has no PO columns. ` +
            `Upload the ${REPORT_LABELS.ITEM_TRACKING} report instead.`,
        },
      ],
    };
  }

  interface Seen {
    poNumbers: Set<string>;
    pageNumber: number;
    rowNumber: number;
  }

  const byDocument = new Map<string, Seen>();
  const withoutPo = new Map<string, { pageNumber: number; rowNumber: number }>();
  const lines: PoReportLine[] = [];

  for (const row of report.rows) {
    const { page: pageNumber, row: rowNumber } = row.source;

    if (!row.poNumber) {
      if (!withoutPo.has(row.documentNumber)) {
        withoutPo.set(row.documentNumber, { pageNumber, rowNumber });
      }
      continue;
    }

    const seen = byDocument.get(row.documentNumber);
    if (!seen) {
      byDocument.set(row.documentNumber, {
        poNumbers: new Set([row.poNumber]),
        pageNumber,
        rowNumber,
      });
    } else {
      seen.poNumbers.add(row.poNumber);
    }

    lines.push({
      documentNumber: row.documentNumber,
      poNumber: row.poNumber,
      ...(row.itemNumber ? { itemNumber: row.itemNumber } : {}),
      product: row.product,
      quantity: row.quantity,
      ...(row.unit ? { unit: row.unit } : {}),
      ...(row.vendorName ? { vendorCode: row.vendorName.trim().toUpperCase() } : {}),
      pageNumber,
      rowNumber,
    });
  }

  const rows: PoReportRow[] = [];

  for (const [documentNumber, seen] of byDocument) {
    const poNumbers = [...seen.poNumbers].sort();

    rows.push({
      documentNumber,
      poNumber: poNumbers.length === 1 ? poNumbers[0]! : null,
      poNumbers,
      pageNumber: seen.pageNumber,
      rowNumber: seen.rowNumber,
    });
  }

  // Most documents have no purchase order: one is only raised where the yard
  // buys in for the job, so on a normal day's report the majority of lines
  // leave the column empty. Reported once as a count rather than once per
  // document — an ordinary state listed alongside genuine failures reads like
  // twelve things went wrong.
  const missing = [...withoutPo.keys()].filter(documentNumber => !byDocument.has(documentNumber));
  if (missing.length > 0) {
    const first = withoutPo.get(missing[0]!)!;
    unreadable.push({
      pageNumber: first.pageNumber,
      rowNumber: first.rowNumber,
      reason:
        `${missing.length} document${missing.length === 1 ? '' : 's'} on this report ` +
        `carr${missing.length === 1 ? 'ies' : 'y'} no PO number and will not be merged ` +
        `(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''})`,
    });
  }

  for (const row of report.unreadable) {
    unreadable.push({ pageNumber: row.page, rowNumber: row.row, reason: row.reason });
  }

  return { rows, lines, unreadable };
}

type VendorClient = Pick<Prisma.TransactionClient, 'supplierSpruceVendor'>;

async function loadVendorIndex(
  client: VendorClient,
  lines: PoReportLine[]
): Promise<Map<string, string>> {
  const codes = [...new Set(
    lines.map(line => line.vendorCode).filter(Boolean) as string[]
  )];
  const index = new Map<string, string>();
  if (codes.length === 0) return index;

  const mappings = await client.supplierSpruceVendor.findMany({
    where: { code: { in: codes }, active: true },
    select: { code: true, supplierId: true, supplier: { select: { active: true } } },
  });
  for (const mapping of mappings) {
    if (mapping.supplier.active) {
      index.set(mapping.code.trim().toUpperCase(), mapping.supplierId);
    }
  }
  return index;
}

function findUnmappedVendors(
  lines: PoReportLine[],
  vendorIndex: Map<string, string>
): PoMergePreview['unmappedVendors'] {

  const byCode = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.vendorCode && !vendorIndex.has(line.vendorCode)) {
      const documents = byCode.get(line.vendorCode) ?? new Set<string>();
      documents.add(line.documentNumber);
      byCode.set(line.vendorCode, documents);
    }
  }

  return [...byCode.entries()].map(([code, documents]) => ({
    code,
    documentNumbers: [...documents].sort(),
  }));
}

/**
 * Works out what the merge would do, without writing anything.
 *
 * Shown before applying because a PO number decides which invoice lines match
 * which orders. A merge run against the wrong report, or against a report from
 * the wrong day, would attach real money to the wrong work.
 */
export async function previewPoReportMerge(
  rows: PoReportRow[],
  unreadable: PoMergePreview['unreadable'] = [],
  lines: PoReportLine[] = []
): Promise<PoMergePreview> {
  const [documents, vendorIndex] = await Promise.all([
    prisma.orderDocument.findMany({
      where: { documentNumber: { in: rows.map(r => r.documentNumber) } },
      select: {
        documentNumber: true,
        customerName: true,
        poNumber: true,
        lines: {
          select: {
            id: true,
            product: true,
            quantity: true,
            unit: true,
            spruceItemNumber: true,
            lineNumber: true,
            poNumber: true,
            supplierId: true,
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
        },
      },
    }),
    loadVendorIndex(prisma, lines),
  ]);
  const unmappedVendors = findUnmappedVendors(lines, vendorIndex);

  const byNumber = new Map(documents.map(d => [d.documentNumber, d]));

  const preview: PoMergePreview = {
    toSet: [],
    conflicts: [],
    unchanged: [],
    multiPo: [],
    unmatched: [],
    unmappedVendors,
    unreadable,
    lineConflicts: [],
    lineMatches: 0,
  };

  for (const row of rows) {
    const document = byNumber.get(row.documentNumber);

    if (!document) {
      preview.unmatched.push(row);
      continue;
    }

    const match: PoMergeMatch = {
      documentNumber: row.documentNumber,
      poNumber: row.poNumber,
      poNumbers: row.poNumbers,
      customerName: document.customerName,
      existingPoNumber: document.poNumber,
      lineCount: document.lines.length,
    };

    if (row.poNumbers.length > 1) preview.multiPo.push(match);
    else if (!document.poNumber) preview.toSet.push(match);
    else if (document.poNumber === row.poNumber) preview.unchanged.push(match);
    else preview.conflicts.push(match);

    const docLines = lines.filter(line => line.documentNumber === row.documentNumber);
    const stored: StoredPoLine[] = document.lines.map(line => ({
      id: line.id,
      product: line.product,
      quantity: line.quantity,
      unit: line.unit,
      spruceItemNumber: line.spruceItemNumber,
      lineNumber: line.lineNumber,
      poNumber: line.poNumber,
      supplierId: line.supplierId,
      hasOperationalLinks:
        line.hasInvoice ||
        line.driverId !== null ||
        line.deliveryStatus !== 'NOT_STARTED' ||
        line._count.deliveries > 0 ||
        line._count.lineItems > 0 ||
        line._count.tickets > 0 ||
        line._count.ticketMatches > 0,
    }));
    const linePlan = planPoLineMerge(docLines, stored, vendorIndex);
    preview.lineMatches += linePlan.updates.length;

    for (const problem of [...linePlan.unmatched, ...linePlan.ambiguous]) {
      preview.lineConflicts.push({
        documentNumber: row.documentNumber,
        rowNumber: docLines[problem.incomingIndex]?.rowNumber ?? row.rowNumber,
        reason: problem.reason,
      });
    }
    for (const update of linePlan.updates) {
      if (!update.poConflict && !update.supplierConflict) continue;
      preview.lineConflicts.push({
        documentNumber: row.documentNumber,
        rowNumber: docLines[update.incomingIndex]?.rowNumber ?? row.rowNumber,
        reason: [
          update.poConflict ? 'the stored line already carries a different PO' : '',
          update.supplierConflict ? 'the stored line already belongs to a different supplier' : '',
        ].filter(Boolean).join(' and '),
      });
    }
  }

  return preview;
}

export interface StoredPoLine extends ExistingLine {
  poNumber: string | null;
  supplierId: string | null;
}

export interface PlannedPoLineUpdate {
  orderId: string;
  incomingIndex: number;
  poNumber: string;
  supplierId?: string;
  poConflict: boolean;
  supplierConflict: boolean;
  changed: boolean;
}

export interface PoLinePlan {
  updates: PlannedPoLineUpdate[];
  unmatched: Array<{ incomingIndex: number; reason: string }>;
  ambiguous: Array<{ incomingIndex: number; reason: string }>;
}

/**
 * Pairs every PO-bearing report line with at most one stored Order.
 * `reconcileDocumentLines` consumes candidates as it matches them, so repeated
 * USKID/MSKID/MISC codes cannot all update the first stored row.
 */
export function planPoLineMerge(
  lines: PoReportLine[],
  storedLines: StoredPoLine[],
  vendorIndex: Map<string, string>
): PoLinePlan {
  const incoming: ParsedSpruceRow[] = lines.map(line => ({
    documentNumber: line.documentNumber,
    customerName: '',
    product: line.product,
    quantity: line.quantity,
    ...(line.itemNumber ? { itemNumber: line.itemNumber } : {}),
    ...(line.unit ? { unit: line.unit } : {}),
    poNumber: line.poNumber,
    ...(line.vendorCode ? { vendorName: line.vendorCode } : {}),
    source: { page: line.pageNumber, row: line.rowNumber },
  }));

  const reconciled = reconcileDocumentLines(incoming, storedLines);
  const byId = new Map(storedLines.map(line => [line.id, line]));
  const updates: PlannedPoLineUpdate[] = [];

  for (const paired of reconciled.paired) {
    const stored = byId.get(paired.id)!;
    const line = lines[paired.incomingIndex]!;
    const supplierId = line.vendorCode
      ? vendorIndex.get(line.vendorCode.trim().toUpperCase())
      : undefined;
    const poConflict = stored.poNumber !== null && stored.poNumber !== line.poNumber;
    const supplierConflict =
      supplierId !== undefined &&
      stored.supplierId !== null &&
      stored.supplierId !== supplierId;

    updates.push({
      orderId: stored.id,
      incomingIndex: paired.incomingIndex,
      poNumber: line.poNumber,
      ...(supplierId ? { supplierId } : {}),
      poConflict,
      supplierConflict,
      changed:
        stored.poNumber !== line.poNumber ||
        (supplierId !== undefined && stored.supplierId !== supplierId),
    });
  }

  return {
    updates,
    unmatched: reconciled.createIndices.map(incomingIndex => ({
      incomingIndex,
      reason: 'no stored order line matches this report line',
    })),
    ambiguous: reconciled.conflicts.map(conflict => ({
      incomingIndex: conflict.incomingIndex,
      reason: conflict.reason,
    })),
  };
}

export interface PoApplySummary {
  documentsUpdated: number;
  documentsSkipped: number;
  linesUpdated: number;
  /** Lines whose stored Order could not be identified from the report line. */
  linesUnmatched: number;
  skippedConflicts: number;
  unmappedVendors: string[];
  lineConflicts: Array<{ documentNumber: string; rowNumber: number; reason: string }>;
}

/**
 * Applies the merge, line by line.
 *
 * Writes the PO onto the document and onto its matched line items, because
 * tickets and invoice lines are matched against `Order.poNumber` and would
 * otherwise never see it. A document buying from two vendors keeps both POs,
 * each on its own lines.
 *
 * Each document re-reads its current state inside its own transaction, so a
 * preview grown stale by a concurrent merge cannot overwrite newer data: the
 * decision to write is made against what is there now, not what was there
 * when the user pressed preview.
 */
export async function applyPoReportMerge(
  rows: PoReportRow[],
  lines: PoReportLine[],
  options: { overwriteConflicts?: boolean } = {}
): Promise<PoApplySummary> {
  const preview = await previewPoReportMerge(rows, [], lines);

  const linesByDocument = new Map<string, PoReportLine[]>();
  for (const line of lines) {
    const group = linesByDocument.get(line.documentNumber);
    if (group) group.push(line);
    else linesByDocument.set(line.documentNumber, [line]);
  }

  let documentsUpdated = 0;
  let documentsSkipped = 0;
  let linesUpdated = 0;
  let linesUnmatched = 0;
  let skippedConflicts = 0;
  const lineConflicts: PoApplySummary['lineConflicts'] = [];

  for (const row of rows) {
    const result = await prisma.$transaction(async tx => {
      // Re-read inside the transaction: the preview may be minutes old.
      const document = await tx.orderDocument.findUnique({
        where: { documentNumber: row.documentNumber },
        select: { id: true, poNumber: true },
      });

      if (!document) {
        const count = linesByDocument.get(row.documentNumber)?.length ?? 0;
        return {
          updated: false,
          linesUpdated: 0,
          linesUnmatched: count,
          skippedConflict: false,
          conflicts: [{
            documentNumber: row.documentNumber,
            rowNumber: row.rowNumber,
            reason: 'the document is not in the system',
          }],
        };
      }

      if (
        row.poNumber !== null &&
        document.poNumber &&
        document.poNumber !== row.poNumber &&
        !options.overwriteConflicts
      ) {
        return {
          updated: false,
          linesUpdated: 0,
          linesUnmatched: 0,
          skippedConflict: true,
          conflicts: [{
            documentNumber: row.documentNumber,
            rowNumber: row.rowNumber,
            reason: `the document already carries PO ${document.poNumber}; replacing it requires explicit approval`,
          }],
        };
      }

      const docLines = linesByDocument.get(row.documentNumber) ?? [];
      if (docLines.length === 0) {
        return {
          updated: false,
          linesUpdated: 0,
          linesUnmatched: 0,
          skippedConflict: false,
          conflicts: [],
        };
      }

      const storedLines = await tx.order.findMany({
        where: { documentId: document.id },
        select: {
          id: true,
          product: true,
          quantity: true,
          unit: true,
          spruceItemNumber: true,
          lineNumber: true,
          poNumber: true,
          supplierId: true,
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

      const vendorIndex = await loadVendorIndex(tx, docLines);
      const stored: StoredPoLine[] = storedLines.map(line => ({
        id: line.id,
        product: line.product,
        quantity: line.quantity,
        unit: line.unit,
        spruceItemNumber: line.spruceItemNumber,
        lineNumber: line.lineNumber,
        poNumber: line.poNumber,
        supplierId: line.supplierId,
        hasOperationalLinks:
          line.hasInvoice ||
          line.driverId !== null ||
          line.deliveryStatus !== 'NOT_STARTED' ||
          line._count.deliveries > 0 ||
          line._count.lineItems > 0 ||
          line._count.tickets > 0 ||
          line._count.ticketMatches > 0,
      }));
      const plan = planPoLineMerge(docLines, stored, vendorIndex);
      const hardProblems = [...plan.unmatched, ...plan.ambiguous];
      const fieldConflicts = plan.updates.filter(
        update => update.poConflict || update.supplierConflict
      );

      if (hardProblems.length > 0 || (fieldConflicts.length > 0 && !options.overwriteConflicts)) {
        const conflicts = hardProblems.map(problem => ({
          documentNumber: row.documentNumber,
          rowNumber: docLines[problem.incomingIndex]?.rowNumber ?? row.rowNumber,
          reason: problem.reason,
        }));
        if (!options.overwriteConflicts) {
          for (const conflict of fieldConflicts) {
            conflicts.push({
              documentNumber: row.documentNumber,
              rowNumber: docLines[conflict.incomingIndex]?.rowNumber ?? row.rowNumber,
              reason: [
                conflict.poConflict ? 'the stored line already carries a different PO' : '',
                conflict.supplierConflict
                  ? 'the stored line already belongs to a different supplier'
                  : '',
              ].filter(Boolean).join(' and '),
            });
          }
        }
        return {
          updated: false,
          linesUpdated: 0,
          linesUnmatched: hardProblems.length,
          skippedConflict: fieldConflicts.length > 0,
          conflicts,
        };
      }

      let changedLines = 0;
      for (const update of plan.updates) {
        if (!update.changed) continue;
        await tx.order.update({
          where: { id: update.orderId },
          data: {
            poNumber: update.poNumber,
            ...(update.supplierId ? { supplierId: update.supplierId } : {}),
          },
          select: { id: true },
        });
        changedLines++;
      }

      // A singular header is useful for the common one-PO case. For a split
      // purchase it would be a lie, so line-level POs remain canonical and the
      // document header is cleared.
      const headerPo = row.poNumbers.length === 1 ? row.poNumber : null;
      const headerChanged = document.poNumber !== headerPo;
      if (headerChanged) {
        await tx.orderDocument.update({
          where: { id: document.id },
          data: { poNumber: headerPo },
          select: { id: true },
        });
      }

      return {
        updated: headerChanged || changedLines > 0,
        linesUpdated: changedLines,
        linesUnmatched: 0,
        skippedConflict: false,
        conflicts: [],
      };
    }, {
      timeout: 30_000,
    });

    if (result.updated) documentsUpdated++;
    else if (result.conflicts.length > 0) documentsSkipped++;
    linesUpdated += result.linesUpdated;
    linesUnmatched += result.linesUnmatched;
    if (result.skippedConflict) skippedConflicts++;
    lineConflicts.push(...result.conflicts);
  }

  const unmappedVendors = preview.unmappedVendors.map(v => v.code);

  return {
    documentsUpdated,
    documentsSkipped,
    linesUpdated,
    linesUnmatched,
    skippedConflicts,
    unmappedVendors,
    lineConflicts,
  };
}
