import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import { parseSpruceDate } from '../../../lib/spruceDate.js';
import { OrderPdfImportService, type ImportSummary } from '../orderPdfImport.service.js';
import type { ParsedSpruceReport, SpruceReportType } from '../spruce/spruceReportTypes.js';
import { deliveryTypeOf } from './lineClass.js';
import {
  batchFlags,
  combineFlags,
  isPickupOrder,
  mergeOrderFacts,
  normalizeAddress,
  stateFlags,
  withFlag,
  type OrderFlag,
  type ReportRows,
} from './mergeOrderFacts.js';

/**
 * The morning import: the three Spruce reports in, one order per document out.
 *
 * Each report is first written by the per-report importer, which pairs its
 * lines with what is stored. The order-level facts are then merged across the
 * reports by `mergeOrderFacts` and flagged. Driver assignments and delivery
 * status live on the lines and are never touched by either step, so an import
 * repeated at noon refreshes the orders without disturbing the day's dispatch.
 */

/**
 * The order the reports are written in.
 *
 * Any order converges on the same lines (the per-report importer is tested
 * for that across all six). This one ends on the delivery report so that the
 * customer name on each line, which only it and the order summary may write,
 * is the delivery report's: the person on the order, not the trade account.
 */
const WRITE_ORDER: SpruceReportType[] = ['ITEM_TRACKING', 'ORDER_SUMMARY', 'DELIVERY'];

/** The reports as the import screen names them: Step 1, 2 and 3. */
export const SLOT_LABELS: Record<SpruceReportType, string> = {
  ORDER_SUMMARY: 'Order Report',
  DELIVERY: 'Delivery Report',
  ITEM_TRACKING: 'Item Tracking Report',
};

/** Flags that mean the order needs a person before it can go out as it is. */
export const ATTENTION_FLAGS: readonly OrderFlag[] = [
  'NO_ADDRESS',
  'CHECK_ADDRESS',
  'DATE_MISMATCH',
  'TOTAL_MISMATCH',
  'EXTRACTION_CHECK_FAILED',
  'NOT_IN_LATEST_REPORT',
];

export class ImportBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportBatchError';
  }
}

export interface BatchFile {
  reportType: SpruceReportType;
  fileName: string;
  buffer: Buffer;
  report: ParsedSpruceReport;
}

export interface BatchReportSummary {
  reportType: SpruceReportType;
  label: string;
  fileName: string;
  pageCount: number | null;
  documentCount: number;
  rowCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  skipped: number;
}

export interface BatchOrder {
  documentNumber: string;
  customerName: string;
  deliveryDate: string | null;
  isPickup: boolean;
  flags: OrderFlag[];
}

export interface BatchSummary {
  batchId: string;
  alreadyImported: boolean;
  dispatchDate: string;
  reports: BatchReportSummary[];
  /** Orders out for delivery on the dispatch date, from every import so far. */
  deliveries: number;
  /** Orders in this upload due after the dispatch date. */
  upcoming: number;
  /** Orders in this upload collected from the yard. */
  pickups: number;
  /** Every order this upload described, with its flags. */
  orders: BatchOrder[];
  /** Orders needing a person, including any no longer on the delivery report. */
  issues: BatchOrder[];
  warnings: string[];
  errors: string[];
}

export function hashFile(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** `8/14` — how the yard writes a day. */
const shortDay = (date: Date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;

function reportRange(report: ParsedSpruceReport): { from: Date; to: Date } | null {
  const from = parseSpruceDate(report.dateRange?.fromRaw);
  const to = parseSpruceDate(report.dateRange?.toRaw);
  return from && to ? { from, to } : null;
}

/**
 * What the dispatcher should know about the files before trusting the result.
 * Warnings, never refusals: re-running yesterday's report on purpose is
 * legitimate, and the person at the screen knows why they did it.
 */
function fileWarnings(files: BatchFile[], dispatchDate: Date): string[] {
  const warnings: string[] = [];
  const day = shortDay(dispatchDate);

  for (const file of files) {
    const range = reportRange(file.report);
    const label = SLOT_LABELS[file.reportType];
    if (!range) {
      warnings.push(`Could not read which dates the ${label} covers; check it is today's.`);
    } else if (dispatchDate < range.from || dispatchDate > range.to) {
      const span = iso(range.from) === iso(range.to)
        ? shortDay(range.from)
        : `${shortDay(range.from)}–${shortDay(range.to)}`;
      warnings.push(`The ${label} is for ${span}, not ${day}.`);
    }
  }

  const present = new Set(files.map(file => file.reportType));
  if (!present.has('ORDER_SUMMARY')) {
    warnings.push('No Order Report: prices, totals and the scheduled-delivery flag were not refreshed.');
  }
  if (!present.has('ITEM_TRACKING')) {
    warnings.push('No Item Tracking Report: addresses, delivery instructions and supplier POs were not refreshed.');
  }
  return warnings;
}

/** Rows of every report, grouped by document number. */
function rowsByDocument(files: BatchFile[]): Map<string, ReportRows> {
  const byDocument = new Map<string, ReportRows>();
  for (const file of files) {
    for (const row of file.report.rows) {
      const rows = byDocument.get(row.documentNumber) ?? {};
      (rows[file.reportType] ??= []).push(row);
      byDocument.set(row.documentNumber, rows);
    }
  }
  return byDocument;
}

function toOrder(document: {
  documentNumber: string;
  customerName: string;
  deliveryDate: Date | null;
  isPickup: boolean;
  flags: string[];
}): BatchOrder {
  return {
    documentNumber: document.documentNumber,
    customerName: document.customerName,
    deliveryDate: document.deliveryDate ? iso(document.deliveryDate) : null,
    isPickup: document.isPickup,
    flags: document.flags as OrderFlag[],
  };
}

const needsAttention = (order: BatchOrder) => order.flags.some(flag => ATTENTION_FLAGS.includes(flag));

/**
 * The earlier upload these exact files came from, if they were all imported
 * already. Re-uploading identical files is a slip, not a request; it is
 * answered with what that upload found and changes nothing.
 */
async function findIdenticalBatch(client: PrismaClient, hashes: string[]) {
  const earlier = await client.importBatch.findMany({
    where: { status: 'DONE', files: { some: { fileHash: { in: hashes } } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, files: { select: { fileHash: true } } },
    take: 20,
  });

  return earlier.find(batch => {
    const seen = new Set(batch.files.map(file => file.fileHash));
    return batch.files.length === hashes.length && hashes.every(hash => seen.has(hash));
  });
}

export async function runImportBatch(
  client: PrismaClient,
  input: { dispatchDate: string; createdById: string; files: BatchFile[] }
): Promise<BatchSummary> {
  const dispatchDate = parseSpruceDate(input.dispatchDate);
  if (!dispatchDate) throw new ImportBatchError(`"${input.dispatchDate}" is not a date.`);

  const files = WRITE_ORDER
    .map(type => input.files.find(file => file.reportType === type))
    .filter((file): file is BatchFile => file !== undefined);
  if (files.length !== input.files.length) {
    throw new ImportBatchError('Each report may be uploaded once per import.');
  }
  // It is the one report that says what goes out today. Without it there is
  // no day to dispatch, only orders.
  if (!files.some(file => file.reportType === 'DELIVERY')) {
    throw new ImportBatchError('The Delivery Report is required: it is the list of what goes out today.');
  }

  const hashes = files.map(file => hashFile(file.buffer));
  const identical = await findIdenticalBatch(client, hashes);
  if (identical?.summary) {
    return { ...(identical.summary as unknown as BatchSummary), alreadyImported: true };
  }

  const batch = await client.importBatch.create({
    data: {
      dispatchDate,
      createdById: input.createdById,
      files: {
        create: files.map((file, index) => {
          const range = reportRange(file.report);
          return {
            reportType: file.reportType,
            fileName: file.fileName,
            fileHash: hashes[index]!,
            pageCount: file.report.pageCount ?? 0,
            reportDateFrom: range?.from ?? null,
            reportDateTo: range?.to ?? null,
            rowCount: file.report.rows.length,
            documentCount: new Set(file.report.rows.map(row => row.documentNumber)).size,
            unreadableCount: file.report.unreadable.length,
            extraction: { rows: file.report.rows, unreadable: file.report.unreadable } as unknown as Prisma.InputJsonValue,
          };
        }),
      },
    },
    select: { id: true },
  });

  try {
    const summary = await mergeBatch(client, batch.id, dispatchDate, files);
    await client.importBatch.update({
      where: { id: batch.id },
      data: {
        status: 'DONE',
        finishedAt: new Date(),
        summary: summary as unknown as Prisma.InputJsonValue,
      },
    });
    return summary;
  } catch (err) {
    await client.importBatch
      .update({ where: { id: batch.id }, data: { status: 'FAILED', finishedAt: new Date() } })
      .catch(() => undefined);
    throw err;
  }
}

async function mergeBatch(
  client: PrismaClient,
  batchId: string,
  dispatchDate: Date,
  files: BatchFile[]
): Promise<BatchSummary> {
  const warnings = fileWarnings(files, dispatchDate);
  const errors: string[] = [];
  const reports: BatchReportSummary[] = [];

  // 1. Orders the delivery report listed before for its day, but not now.
  // Decided before anything is written: the other reports may carry a
  // different date for such an order, and importing them would quietly move it
  // off the day. It is never deleted or moved — in Spruce it was probably
  // rescheduled or cancelled, it may already be on a truck, and the
  // dispatcher decides.
  const deliveryFile = files.find(file => file.reportType === 'DELIVERY')!;
  const deliveryRange = reportRange(deliveryFile.report) ?? { from: dispatchDate, to: dispatchDate };
  const listed = [...new Set(deliveryFile.report.rows.map(row => row.documentNumber))];
  const droppedFromDay = await client.orderDocument.findMany({
    where: {
      deliveryDate: { gte: deliveryRange.from, lte: deliveryRange.to },
      sourceReports: { has: 'DELIVERY' },
      documentNumber: { notIn: listed },
    },
    select: { id: true, documentNumber: true, flags: true, deliveryDate: true },
  });
  const droppedDay = new Map(droppedFromDay.map(document => [document.documentNumber, document.deliveryDate!]));

  // 2. Each report through the per-report importer, which owns the lines.
  for (const file of files) {
    const result: ImportSummary = await OrderPdfImportService.applyReport(
      client,
      file.report,
      `batch-${batchId}-${file.reportType}`
    );
    const range = reportRange(file.report);
    reports.push({
      reportType: file.reportType,
      label: SLOT_LABELS[file.reportType],
      fileName: file.fileName,
      pageCount: file.report.pageCount ?? null,
      documentCount: new Set(file.report.rows.map(row => row.documentNumber)).size,
      rowCount: file.report.rows.length,
      dateFrom: range ? iso(range.from) : null,
      dateTo: range ? iso(range.to) : null,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      conflicts: result.conflicts,
      skipped: result.skipped,
    });
    for (const error of result.errors) errors.push(`${SLOT_LABELS[file.reportType]}: ${error.error}`);
  }

  // 3. Each order's facts merged across the reports, then flagged.
  const presentReports = new Set(files.map(file => file.reportType));
  const summaryFile = files.find(file => file.reportType === 'ORDER_SUMMARY');
  const summaryRange = summaryFile ? reportRange(summaryFile.report) : null;
  const context = { reports: presentReports, ...(summaryRange ? { orderSummaryRange: summaryRange } : {}) };
  // Decided by any upload carrying the delivery report: an order on it is,
  // by definition, in the latest one.
  const alsoDecided: OrderFlag[] = presentReports.has('DELIVERY') ? ['NOT_IN_LATEST_REPORT'] : [];

  const orders: BatchOrder[] = [];
  for (const [documentNumber, rows] of rowsByDocument(files)) {
    const stored = await client.orderDocument.findUnique({
      where: { documentNumber },
      select: {
        id: true,
        flags: true,
        sourceReports: true,
        deliveryDate: true,
        shippingAddress: true,
        deliveryInstructions: true,
        lines: { select: { spruceItemNumber: true, product: true, poNumber: true } },
      },
    });
    // The per-report importer refused it and has already said why.
    if (!stored) continue;

    const patch = mergeOrderFacts(rows);
    // A dropped order keeps its day until the dispatcher moves it.
    const keptDay = droppedDay.get(documentNumber);
    if (keptDay) patch.deliveryDate = keptDay;
    const lines = stored.lines.map(line => ({
      itemCode: line.spruceItemNumber,
      description: line.product,
      poNumber: line.poNumber,
    }));
    const state = {
      deliveryDate: patch.deliveryDate ?? stored.deliveryDate,
      shippingAddress: patch.shippingAddress ?? stored.shippingAddress,
      deliveryInstructions: patch.deliveryInstructions ?? stored.deliveryInstructions,
      lines,
    };

    const decided = batchFlags(rows, context);
    // An order closed in Spruce is not waiting to be collected either.
    const isPickup = decided.flags.includes('NOT_OPEN') ? false : isPickupOrder(state);
    const flags = combineFlags(
      stored.flags,
      [...decided.decided, ...alsoDecided],
      [
        ...decided.flags,
        ...stateFlags(state, isPickup),
        ...(keptDay ? (['NOT_IN_LATEST_REPORT'] as const) : []),
      ]
    );

    const written = await client.orderDocument.update({
      where: { id: stored.id },
      data: {
        ...patch,
        addressNormalized: normalizeAddress(state.shippingAddress),
        deliveryType: deliveryTypeOf(lines),
        isPickup,
        flags,
        sourceReports: [...new Set([...stored.sourceReports, ...Object.keys(rows)])].sort(),
        lastBatchId: batchId,
      },
      select: { documentNumber: true, customerName: true, deliveryDate: true, isPickup: true, flags: true },
    });
    // The per-report importer dated each line by whichever report it read
    // last; the order's merged date is the one that holds.
    if (state.deliveryDate) {
      await client.order.updateMany({ where: { documentId: stored.id }, data: { deliveryDate: state.deliveryDate } });
    }
    orders.push(toOrder(written));
  }

  // 4. Dropped orders no report in this upload mentions at all. Nothing new
  // is known about them, so every flag they had stays.
  const merged = new Set(orders.map(order => order.documentNumber));
  const dropped: BatchOrder[] = [];
  for (const document of droppedFromDay.filter(document => !merged.has(document.documentNumber))) {
    const written = await client.orderDocument.update({
      where: { id: document.id },
      data: { flags: withFlag(document.flags, 'NOT_IN_LATEST_REPORT') },
      select: { documentNumber: true, customerName: true, deliveryDate: true, isPickup: true, flags: true },
    });
    dropped.push(toOrder(written));
  }

  const deliveries = await client.orderDocument.count({
    where: { deliveryDate: dispatchDate, isPickup: false },
  });

  return {
    batchId,
    alreadyImported: false,
    dispatchDate: iso(dispatchDate),
    reports,
    deliveries,
    upcoming: orders.filter(order => order.deliveryDate !== null && order.deliveryDate > iso(dispatchDate)).length,
    pickups: orders.filter(order => order.isPickup).length,
    orders,
    issues: [...orders, ...dropped].filter(needsAttention),
    warnings,
    errors,
  };
}
