import { prisma } from '../../db/prisma.js';
import { findCell, readPdfTableRows } from './pdfTableReader.js';

/**
 * The second half of the two-step Spruce import.
 *
 * Spruce exports its data the way the underlying tables are shaped rather than
 * the way the yard reads it: the delivery report carries the line items, and
 * the PO numbers live in a separate report. Neither report is complete on its
 * own, and the only thing linking them is the document number.
 *
 * That number is now a key (`OrderDocument.documentNumber`), so this is a plain
 * join rather than anything a model needs to work out. The merge is
 * deterministic and reviewable: parse, show what matches, then write only when
 * a person says so.
 */

export interface PoReportRow {
  documentNumber: string;
  poNumber: string;
  pageNumber: number;
  rowNumber: number;
}

export interface PoMergeMatch {
  documentNumber: string;
  poNumber: string;
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
  /** Rows whose document number is not in the system. */
  unmatched: PoReportRow[];
  /** Rows the parser could not read a document number and PO from. */
  unreadable: Array<{ pageNumber: number; rowNumber: number; reason: string }>;
}

const DOCUMENT_ALIASES = ['document', 'documentno', 'documentnumber', 'docno', 'doc', 'order', 'orderno', 'ordernumber'];
const PO_ALIASES = ['podocument', 'ponumber', 'po', 'purchaseorder', 'ponum', 'customerpo'];

/**
 * Reads (document number, PO number) pairs out of the PO report.
 *
 * Column names vary between Spruce report definitions, so headers are matched
 * against alias lists rather than fixed positions. A row that does not yield
 * both values is reported rather than dropped — a silently skipped row is how
 * a PO goes missing without anyone noticing.
 */
export async function parsePoReport(buffer: Buffer): Promise<{
  rows: PoReportRow[];
  unreadable: PoMergePreview['unreadable'];
}> {
  const tableRows = await readPdfTableRows(buffer);

  const rows: PoReportRow[] = [];
  const unreadable: PoMergePreview['unreadable'] = [];

  for (const row of tableRows) {
    const documentNumber = findCell(row.cells, DOCUMENT_ALIASES)?.trim();
    const poNumber = findCell(row.cells, PO_ALIASES)?.trim();

    if (!documentNumber && !poNumber) continue; // blank or total row

    if (!documentNumber || !poNumber) {
      unreadable.push({
        pageNumber: row.pageNumber,
        rowNumber: row.rowNumber,
        reason: !documentNumber
          ? `no document number (columns seen: ${Object.keys(row.cells).join(', ')})`
          : `no PO number for document ${documentNumber}`,
      });
      continue;
    }

    rows.push({ documentNumber, poNumber, pageNumber: row.pageNumber, rowNumber: row.rowNumber });
  }

  return { rows, unreadable };
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
  unreadable: PoMergePreview['unreadable'] = []
): Promise<PoMergePreview> {
  const documents = await prisma.orderDocument.findMany({
    where: { documentNumber: { in: rows.map(r => r.documentNumber) } },
    select: {
      documentNumber: true,
      customerName: true,
      poNumber: true,
      _count: { select: { lines: true } },
    },
  });

  const byNumber = new Map(documents.map(d => [d.documentNumber, d]));

  const preview: PoMergePreview = { toSet: [], conflicts: [], unchanged: [], unmatched: [], unreadable };

  for (const row of rows) {
    const document = byNumber.get(row.documentNumber);

    if (!document) {
      preview.unmatched.push(row);
      continue;
    }

    const match: PoMergeMatch = {
      documentNumber: row.documentNumber,
      poNumber: row.poNumber,
      customerName: document.customerName,
      existingPoNumber: document.poNumber,
      lineCount: document._count.lines,
    };

    if (!document.poNumber) preview.toSet.push(match);
    else if (document.poNumber === row.poNumber) preview.unchanged.push(match);
    else preview.conflicts.push(match);
  }

  return preview;
}

/**
 * Applies the merge.
 *
 * Writes the PO onto the document and onto its line items, because tickets and
 * invoice lines are matched against `Order.poNumber` and would otherwise never
 * see it.
 *
 * Conflicts — a document already carrying a different PO — are skipped unless
 * `overwriteConflicts` is set. Silently overwriting one PO with another would
 * re-point existing ticket and invoice matches with no record of why.
 */
export async function applyPoReportMerge(
  rows: PoReportRow[],
  options: { overwriteConflicts?: boolean } = {}
): Promise<{ documentsUpdated: number; linesUpdated: number; skippedConflicts: number }> {
  const preview = await previewPoReportMerge(rows);
  const toApply = options.overwriteConflicts
    ? [...preview.toSet, ...preview.conflicts]
    : preview.toSet;

  let documentsUpdated = 0;
  let linesUpdated = 0;

  for (const match of toApply) {
    await prisma.$transaction(async tx => {
      const document = await tx.orderDocument.update({
        where: { documentNumber: match.documentNumber },
        data: { poNumber: match.poNumber },
        select: { id: true },
      });

      const result = await tx.order.updateMany({
        where: { documentId: document.id },
        data: { poNumber: match.poNumber },
      });

      documentsUpdated++;
      linesUpdated += result.count;
    });
  }

  return {
    documentsUpdated,
    linesUpdated,
    skippedConflicts: options.overwriteConflicts ? 0 : preview.conflicts.length,
  };
}
