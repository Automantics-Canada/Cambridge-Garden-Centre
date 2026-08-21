import { prisma } from '../../db/prisma.js';
import { parseSprucePdf, REPORT_LABELS } from './spruce/parseSprucePdf.js';

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

/**
 * Reads (document number, PO number) pairs out of the PO report.
 *
 * Only the item-tracking report carries a PO. It prints one line per item, so
 * a document with several items repeats its PO on each of them; the pairs are
 * reduced to one per document here.
 *
 * A document whose lines disagree about their PO is reported rather than
 * resolved. So is a document with no PO at all, and so is a report of the wrong
 * kind. A silently skipped row is how a PO goes missing without anyone noticing
 * it went.
 */
export async function parsePoReport(buffer: Buffer): Promise<{
  rows: PoReportRow[];
  unreadable: PoMergePreview['unreadable'];
}> {
  const report = await parseSprucePdf(buffer);
  const unreadable: PoMergePreview['unreadable'] = [];

  if (report.type !== 'ITEM_TRACKING') {
    // Reporting this per row would bury the point under one entry per line.
    return {
      rows: [],
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
    poNumber: string;
    pageNumber: number;
    rowNumber: number;
    conflictsWith?: string;
  }

  const byDocument = new Map<string, Seen>();
  const withoutPo = new Map<string, { pageNumber: number; rowNumber: number }>();

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
      byDocument.set(row.documentNumber, { poNumber: row.poNumber, pageNumber, rowNumber });
    } else if (seen.poNumber !== row.poNumber && !seen.conflictsWith) {
      seen.conflictsWith = row.poNumber;
    }
  }

  const rows: PoReportRow[] = [];

  for (const [documentNumber, seen] of byDocument) {
    if (seen.conflictsWith) {
      unreadable.push({
        pageNumber: seen.pageNumber,
        rowNumber: seen.rowNumber,
        reason:
          `document ${documentNumber} has more than one PO on it ` +
          `(${seen.poNumber} and ${seen.conflictsWith}); left alone`,
      });
      continue;
    }

    rows.push({
      documentNumber,
      poNumber: seen.poNumber,
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
