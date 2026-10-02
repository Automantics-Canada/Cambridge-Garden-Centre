import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import { parseSpruceDate } from '../../../lib/spruceDate.js';
import { OrderPdfImportService, type ImportSummary } from '../orderPdfImport.service.js';
import type { ParsedSpruceReport, SpruceReportType } from '../spruce/spruceReportTypes.js';
import { deliveryTypeOf } from './lineClass.js';
import { reassertOverrides } from '../edits/orderEdits.service.js';
import { diffOrder, isOverridden, snapshotOrders, type ChangeRow, type OrderSnapshot } from './orderChanges.js';
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

/**
 * What the dispatcher is told after an upload.
 *
 * The orders, counts and issues are read from the database as it stands when
 * the summary is made, so a replay of files already imported tells the truth
 * about the day now — after the dispatcher's corrections and moves — rather
 * than repeating what the first upload found.
 */
export interface BatchSummary {
  batchId: string;
  /** These exact files were imported before for this dispatch date; nothing was written. */
  alreadyImported: boolean;
  dispatchDate: string;
  /** Each report's file, and what this upload wrote from it: all zeros on a replay. */
  reports: BatchReportSummary[];
  /** Orders out for delivery on the dispatch date, from every import so far. */
  deliveries: number;
  /** Orders in this upload due after the dispatch date. */
  upcoming: number;
  /** Orders in this upload collected from the yard. */
  pickups: number;
  /**
   * Orders imported before that this upload changed in a way the board marks
   * "Updated". Zero on a replay, which changes nothing. Absent from summaries
   * of older uploads.
   */
  updated: number;
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

const SUMMARY_ORDER_SELECT = {
  documentNumber: true,
  customerName: true,
  deliveryDate: true,
  isPickup: true,
  flags: true,
} as const;

type WriteCounts = Pick<ImportSummary, 'created' | 'updated' | 'unchanged' | 'conflicts' | 'skipped'>;

/** A replay writes nothing, from any report. */
const NOTHING_WRITTEN: WriteCounts = { created: 0, updated: 0, unchanged: 0, conflicts: 0, skipped: 0 };

function reportSummary(file: BatchFile, written: WriteCounts): BatchReportSummary {
  const range = reportRange(file.report);
  return {
    reportType: file.reportType,
    label: SLOT_LABELS[file.reportType],
    fileName: file.fileName,
    pageCount: file.report.pageCount ?? null,
    documentCount: new Set(file.report.rows.map(row => row.documentNumber)).size,
    rowCount: file.report.rows.length,
    dateFrom: range ? iso(range.from) : null,
    dateTo: range ? iso(range.to) : null,
    created: written.created,
    updated: written.updated,
    unchanged: written.unchanged,
    conflicts: written.conflicts,
    skipped: written.skipped,
  };
}

/**
 * Orders the delivery report listed before for its days, but not now.
 *
 * Only orders the delivery report put there: a dispatcher who moved an order
 * to the day knows why it is here.
 */
function findDroppedFromDay(client: PrismaClient, files: BatchFile[], dispatchDate: Date) {
  const deliveryFile = files.find(file => file.reportType === 'DELIVERY')!;
  const deliveryRange = reportRange(deliveryFile.report) ?? { from: dispatchDate, to: dispatchDate };
  const listed = [...new Set(deliveryFile.report.rows.map(row => row.documentNumber))];
  return client.orderDocument.findMany({
    where: {
      deliveryDate: { gte: deliveryRange.from, lte: deliveryRange.to },
      sourceReports: { has: 'DELIVERY' },
      documentNumber: { notIn: listed },
      overrides: { none: { field: 'deliveryDate' } },
    },
    select: { id: true, documentNumber: true, flags: true, deliveryDate: true },
  });
}

/**
 * The summary of an upload, read from the database as it stands now.
 *
 * Both a real import (after every write) and a replay come through here, so
 * what a replay says cannot drift from what an import would.
 */
async function summarize(
  client: PrismaClient,
  input: {
    batchId: string;
    alreadyImported: boolean;
    dispatchDate: Date;
    files: BatchFile[];
    reports: BatchReportSummary[];
    updated: number;
    /** Orders dropped from the day that no report in the upload mentions. */
    dropped: string[];
    warnings: string[];
    errors: string[];
  }
): Promise<BatchSummary> {
  const described = [...rowsByDocument(input.files).keys()];
  const stored = await client.orderDocument.findMany({
    where: { documentNumber: { in: [...described, ...input.dropped] } },
    select: SUMMARY_ORDER_SELECT,
  });
  const byNumber = new Map(stored.map(document => [document.documentNumber, toOrder(document)]));
  // A document every report refused was never stored; the importer said why.
  const orders = described.flatMap(documentNumber => byNumber.get(documentNumber) ?? []);
  const describedSet = new Set(described);
  const dropped = input.dropped
    .filter(documentNumber => !describedSet.has(documentNumber))
    .flatMap(documentNumber => byNumber.get(documentNumber) ?? []);

  const day = iso(input.dispatchDate);
  const deliveries = await client.orderDocument.count({
    where: { deliveryDate: input.dispatchDate, isPickup: false },
  });

  return {
    batchId: input.batchId,
    alreadyImported: input.alreadyImported,
    dispatchDate: day,
    reports: input.reports,
    deliveries,
    upcoming: orders.filter(order => order.deliveryDate !== null && order.deliveryDate > day).length,
    pickups: orders.filter(order => order.isPickup).length,
    updated: input.updated,
    orders,
    issues: [...orders, ...dropped].filter(needsAttention),
    warnings: input.warnings,
    errors: input.errors,
  };
}

/**
 * The earlier upload of these exact files for the same dispatch date, if
 * there was one. Re-uploading identical files for a day is a slip, not a
 * request: they hold nothing that upload did not already apply, and applying
 * them again could only undo a later upload for the day. The same files for
 * another dispatch date are a different request and are imported.
 */
async function findIdenticalBatch(client: PrismaClient, dispatchDate: Date, hashes: string[]) {
  const earlier = await client.importBatch.findMany({
    where: { status: 'DONE', dispatchDate, files: { some: { fileHash: { in: hashes } } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, files: { select: { fileHash: true } } },
    take: 20,
  });

  return earlier.find(batch => {
    const seen = new Set(batch.files.map(file => file.fileHash));
    return batch.files.length === hashes.length && hashes.every(hash => seen.has(hash));
  });
}

/**
 * The answer to a replay: nothing is written, and the day is described as it
 * stands now. Only the importer's errors are taken from the earlier upload —
 * they are about the files, which are the same bytes, and finding them again
 * would mean importing again.
 */
async function replaySummary(
  client: PrismaClient,
  batch: { id: string; summary: Prisma.JsonValue },
  dispatchDate: Date,
  files: BatchFile[]
): Promise<BatchSummary> {
  const earlier = (batch.summary ?? {}) as Partial<BatchSummary>;
  const dropped = await findDroppedFromDay(client, files, dispatchDate);
  return summarize(client, {
    batchId: batch.id,
    alreadyImported: true,
    dispatchDate,
    files,
    reports: files.map(file => reportSummary(file, NOTHING_WRITTEN)),
    updated: 0,
    dropped: dropped.map(document => document.documentNumber),
    warnings: fileWarnings(files, dispatchDate),
    errors: Array.isArray(earlier.errors) ? earlier.errors : [],
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
  const identical = await findIdenticalBatch(client, dispatchDate, hashes);
  if (identical) return replaySummary(client, identical, dispatchDate, files);

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
  const droppedFromDay = await findDroppedFromDay(client, files, dispatchDate);
  const droppedDay = new Map(droppedFromDay.map(document => [document.documentNumber, document.deliveryDate!]));

  // What the orders this upload describes said before it, so what it changes
  // can be logged. Orders not stored yet are new, not updated.
  const described = rowsByDocument(files);
  const existing = await client.orderDocument.findMany({
    where: { documentNumber: { in: [...described.keys()] } },
    select: { id: true, documentNumber: true },
  });
  const before = await snapshotOrders(client, existing.map(document => document.id));
  const seen = new Map<string, { paired: Set<string>; created: Set<string> }>();
  const noteLines = (documentNumber: string, lines: { pairedIds: string[]; createdIds: string[] }) => {
    const entry = seen.get(documentNumber) ?? { paired: new Set<string>(), created: new Set<string>() };
    for (const id of lines.pairedIds) entry.paired.add(id);
    for (const id of lines.createdIds) entry.created.add(id);
    seen.set(documentNumber, entry);
  };

  // 2. Each report through the per-report importer, which owns the lines.
  for (const file of files) {
    const result: ImportSummary = await OrderPdfImportService.applyReport(
      client,
      file.report,
      `batch-${batchId}-${file.reportType}`,
      noteLines
    );
    reports.push(reportSummary(file, result));
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

  for (const [documentNumber, rows] of described) {
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

    await client.orderDocument.update({
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
      select: { id: true },
    });
    // The per-report importer dated each line by whichever report it read
    // last; the order's merged date is the one that holds.
    if (state.deliveryDate) {
      await client.order.updateMany({ where: { documentId: stored.id }, data: { deliveryDate: state.deliveryDate } });
    }
    // The merge wrote Spruce's word; a dispatcher's corrections go back over
    // it, and what follows from them — the address flag, the day — with them.
    await reassertOverrides(client, stored.id);
  }

  // 4. What changed on the orders that were already here, read back after
  // every write — the merge, the corrections put back — and logged.
  const updated = await logChanges(client, batchId, existing, before, seen);

  // 5. Dropped orders no report in this upload mentions at all. Nothing new
  // is known about them, so every flag they had stays.
  const dropped = droppedFromDay.filter(document => !described.has(document.documentNumber));
  for (const document of dropped) {
    await client.orderDocument.update({
      where: { id: document.id },
      data: { flags: withFlag(document.flags, 'NOT_IN_LATEST_REPORT') },
      select: { id: true },
    });
  }

  // 6. What the dispatcher is told, read back after every write.
  return summarize(client, {
    batchId,
    alreadyImported: false,
    dispatchDate,
    files,
    reports,
    updated,
    dropped: dropped.map(document => document.documentNumber),
    warnings,
    errors,
  });
}

/**
 * Logs what this upload changed on orders that existed before it, and returns
 * how many of them changed in a way the board marks "Updated": a change to a
 * field the dispatcher has corrected is logged with Spruce's values but does
 * not count, since the driver still sees the correction.
 */
async function logChanges(
  client: PrismaClient,
  batchId: string,
  existing: Array<{ id: string; documentNumber: string }>,
  before: Map<string, OrderSnapshot>,
  seen: Map<string, { paired: Set<string>; created: Set<string> }>
): Promise<number> {
  const after = await snapshotOrders(client, existing.map(document => document.id));
  const overrides = await client.orderOverride.findMany({
    where: { documentId: { in: existing.map(document => document.id) } },
    select: { documentId: true, field: true, lineId: true },
  });

  const rows: Array<ChangeRow & { documentId: string; batchId: string }> = [];
  let updated = 0;
  for (const document of existing) {
    const was = before.get(document.id);
    const now = after.get(document.id);
    if (!was || !now) continue;

    // A document every report refused had no line written: nothing about its
    // lines can be concluded, least of all that Spruce took them all off.
    const lines = seen.get(document.documentNumber)
      ?? { paired: new Set(was.lines.filter(line => !line.removed).map(line => line.id)), created: new Set<string>() };
    const changes = diffOrder(was, now, lines);
    const corrected = overrides.filter(override => override.documentId === document.id);
    if (changes.some(change => !isOverridden(corrected, change))) updated++;
    rows.push(...changes.map(change => ({ ...change, documentId: document.id, batchId })));
  }

  if (rows.length > 0) await client.orderChange.createMany({ data: rows });
  return updated;
}
