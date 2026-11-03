// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { markDoneOutsideApp } from '../src/modules/dispatch/doneOutsideApp.service.js';
import { markNotQuotation } from '../src/modules/orders/edits/orderEdits.service.js';
import { runImportBatch, type BatchFile } from '../src/modules/orders/import/importBatch.service.js';
import { refuseQuotationLine } from '../src/modules/orders/quotations.js';
import type { ParsedSpruceReport, ParsedSpruceRow, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';

/**
 * "Not a quotation" against PostgreSQL, through real imports.
 *
 * The import calls a document a quotation when Item Tracking lists it inside
 * the Order report's range and the Order report leaves it out. An order
 * entered, delivered and closed between two uploads looks the same. Before
 * the office could say so, nothing took QUOTE off such an order, and its
 * tickets and invoice lines could never be linked to it.
 *
 * Every name and number is invented.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();
const runnable = confirmed && loopback;

const DAY = '2026-09-02';
const SPRUCE_DAY = '9/2/2026';
/** On today's Delivery and Order reports: so the upload has both. */
const OPEN = '9900-000100';
/** Entered, delivered and closed in Spruce on the day: only on Item Tracking. */
const CLOSED_SAME_DAY = '9900-000101';
const ALSO_CLOSED = '9900-000102';

function row(documentNumber: string, extra: Partial<ParsedSpruceRow>): ParsedSpruceRow {
  return {
    documentNumber,
    customerName: 'Example Yard Co',
    product: 'Garden Soil Bulk',
    itemNumber: 'SOILGRDNA',
    quantity: 3,
    unit: 'CY',
    source: { page: 1, row: 1 },
    ...extra,
  };
}

const charge = (documentNumber: string, extra: Partial<ParsedSpruceRow>) =>
  row(documentNumber, { product: 'Delivery charge', itemNumber: 'MISCDEL', quantity: 1, unit: 'EA', ...extra });

function report(type: SpruceReportType, rows: ParsedSpruceRow[]): ParsedSpruceReport {
  return { type, rows, unreadable: [], pageCount: 1, readBy: 'PARSER', dateRange: { fromRaw: SPRUCE_DAY, toRaw: SPRUCE_DAY } };
}

function files(stamp: string): BatchFile[] {
  const tracking = { orderDateRaw: SPRUCE_DAY, deliveryDateRaw: SPRUCE_DAY, shippingAddress: '1 Example Rd, Cambridge' };
  const reports: Record<SpruceReportType, ParsedSpruceReport> = {
    ITEM_TRACKING: report('ITEM_TRACKING', [OPEN, CLOSED_SAME_DAY, ALSO_CLOSED].flatMap(number => [
      row(number, tracking),
      charge(number, tracking),
    ])),
    ORDER_SUMMARY: report('ORDER_SUMMARY', [
      row(OPEN, { orderDateRaw: SPRUCE_DAY, unitPrice: 40, remaining: 195 }),
      charge(OPEN, { orderDateRaw: SPRUCE_DAY, unitPrice: 75, remaining: 195 }),
    ]),
    DELIVERY: report('DELIVERY', [
      row(OPEN, { deliveryDateRaw: SPRUCE_DAY, phone: '519-555-0100' }),
      charge(OPEN, { deliveryDateRaw: SPRUCE_DAY, phone: '519-555-0100' }),
    ]),
  };
  return (['ITEM_TRACKING', 'ORDER_SUMMARY', 'DELIVERY'] as const).map(reportType => ({
    reportType,
    fileName: `${reportType}.pdf`,
    buffer: Buffer.from(`${stamp}-${reportType}`),
    report: reports[reportType],
  }));
}

const documentOf = (documentNumber: string) =>
  prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber }, include: { lines: true } });

describe('"Not a quotation" (PostgreSQL)', { skip: !runnable && 'needs CGC_TEST_CONFIRM_DISPOSABLE=1 and a loopback DATABASE_URL' }, () => {
  let userId: string;
  const importDay = (stamp: string) => runImportBatch(prisma, { dispatchDate: DAY, createdById: userId, files: files(stamp) });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ImportBatch", "OrderDocument", "Order", "User", "Delivery", "Driver", "AuditLog" RESTART IDENTITY CASCADE'
    );
    userId = (await prisma.user.create({
      data: { name: 'Office', email: 'office-quote@example.test', passwordHash: 'x', role: 'AP_USER' },
    })).id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('takes QUOTE off, records who did it, and a later upload keeps the office\'s word', async () => {
    await importDay('morning');
    const before = await documentOf(CLOSED_SAME_DAY);
    assert.ok(before.flags.includes('QUOTE'), 'the import takes it for a quotation');
    await assert.rejects(refuseQuotationLine(prisma, before.lines[0]!.id, 'a ticket'), (err: any) =>
      err.status === 409 && /mark it "Not a quotation"/.test(err.message));

    assert.deepEqual(await markNotQuotation(before.id, userId), { changed: true });

    let after = await documentOf(CLOSED_SAME_DAY);
    assert.ok(!after.flags.includes('QUOTE'));
    assert.ok(after.flags.includes('NOT_A_QUOTE'));
    assert.equal(after.isPickup, false, 'charged for delivery: a delivery again');
    await refuseQuotationLine(prisma, after.lines[0]!.id, 'a ticket');
    const audit = await prisma.auditLog.findMany({ where: { entityId: before.id } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.performedById, userId);
    assert.equal((audit[0]!.details as { action: string }).action, 'NOT_A_QUOTATION');

    // Marking it again changes nothing and logs nothing.
    assert.deepEqual(await markNotQuotation(before.id, userId), { changed: false });
    assert.equal(await prisma.auditLog.count(), 1);

    // The next upload says the same as the morning's: in range, left off the
    // Order report. It is an order now, so closed, never a quotation again.
    await importDay('noon');
    after = await documentOf(CLOSED_SAME_DAY);
    assert.ok(!after.flags.includes('QUOTE'));
    assert.ok(after.flags.includes('NOT_OPEN'));
    assert.ok(after.flags.includes('NOT_A_QUOTE'));
    // Its own day lists it again (a closed order may have gone out that day).
    const board = await DispatchService.getDispatchBoard(DAY, DAY);
    assert.ok(board.unassignedOrders.some(order => order.spruceOrderId === CLOSED_SAME_DAY));
    // The other one, untouched, is still a quotation.
    assert.ok((await documentOf(ALSO_CLOSED)).flags.includes('QUOTE'));
  });

  it('takes QUOTE off when Item Tracking later shows a PO on it, after its entry date left the Order report\'s range', async () => {
    await importDay('morning');
    assert.ok((await documentOf(CLOSED_SAME_DAY)).flags.includes('QUOTE'));

    // The next day: the Order report covers only 9/3, so the 9/2 documents
    // are outside its range. Item Tracking still lists them, and one now
    // carries a supplier PO: it is an order, whatever the dates.
    const NEXT = '9/3/2026';
    const nextOpen = '9900-000103';
    const tracking = { orderDateRaw: SPRUCE_DAY, deliveryDateRaw: NEXT, shippingAddress: '1 Example Rd, Cambridge' };
    const nextReports: Record<SpruceReportType, ParsedSpruceReport> = {
      ITEM_TRACKING: {
        ...report('ITEM_TRACKING', [
          row(CLOSED_SAME_DAY, { ...tracking, poNumber: '9900-300101' }),
          row(ALSO_CLOSED, tracking),
          row(nextOpen, { orderDateRaw: NEXT, deliveryDateRaw: NEXT }),
        ]),
        dateRange: { fromRaw: SPRUCE_DAY, toRaw: NEXT },
      },
      ORDER_SUMMARY: {
        ...report('ORDER_SUMMARY', [row(nextOpen, { orderDateRaw: NEXT, unitPrice: 40, remaining: 120 })]),
        dateRange: { fromRaw: NEXT, toRaw: NEXT },
      },
      DELIVERY: report('DELIVERY', [row(nextOpen, { deliveryDateRaw: NEXT, phone: '519-555-0101' })]),
    };
    await runImportBatch(prisma, {
      dispatchDate: '2026-09-03',
      createdById: userId,
      files: (['ITEM_TRACKING', 'ORDER_SUMMARY', 'DELIVERY'] as const).map(reportType => ({
        reportType,
        fileName: `${reportType}.pdf`,
        buffer: Buffer.from(`next-${reportType}`),
        report: nextReports[reportType],
      })),
    });

    const withPo = await documentOf(CLOSED_SAME_DAY);
    assert.ok(!withPo.flags.includes('QUOTE'), `flags: ${withPo.flags.join(', ')}`);
    assert.ok(withPo.lines.some(line => line.poNumber === '9900-300101'));
    // Nothing new about the other one: still a quotation, and not re-read.
    assert.ok((await documentOf(ALSO_CLOSED)).flags.includes('QUOTE'));
  });

  it('answers 404 for an order that is not there', async () => {
    await assert.rejects(markNotQuotation('00000000-0000-4000-8000-000000000000', userId), (err: any) => err.status === 404);
  });

  it('takes QUOTE off an order the office marks done outside the app: it went out, so it was one', async () => {
    await importDay('morning');
    const quote = await documentOf(ALSO_CLOSED);
    assert.ok(quote.flags.includes('QUOTE'));

    await markDoneOutsideApp(quote.id, userId);

    const after = await documentOf(ALSO_CLOSED);
    assert.ok(!after.flags.includes('QUOTE'));
    assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { documentId: quote.id } })).status, 'DELIVERED');
    // The stop is history the import reads: the next upload does not flag it again.
    await importDay('noon');
    const again = await documentOf(ALSO_CLOSED);
    assert.ok(!again.flags.includes('QUOTE'));
    assert.ok(again.flags.includes('NOT_OPEN'));
  });
});
