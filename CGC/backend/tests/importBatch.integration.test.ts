// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { parseEditRequest } from '../src/modules/orders/edits/editableFields.js';
import { applyOrderEdits } from '../src/modules/orders/edits/orderEdits.service.js';
import { ImportBatchError, runImportBatch, type BatchFile } from '../src/modules/orders/import/importBatch.service.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import type { ParsedSpruceReport, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
import { deliveryReport, itemTrackingReport, orderSummaryReport } from './fixtures/spruceLayouts.js';

/**
 * The morning import end to end against PostgreSQL: three synthetic reports
 * in, one merged order per document out, and the guarantees a dispatcher
 * relies on when the reports are run again at noon.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

async function resetDatabase(): Promise<void> {
  if (!disposableConfirmed) {
    throw new Error('Refusing to clear a database without SPRUCE_TEST_CONFIRM_DISPOSABLE=1');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ImportBatch", "OrderDocument", "Order", "User", "SpruceImportJob" RESTART IDENTITY CASCADE'
  );
}

async function seedUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { name: 'Import Tester', email: 'import-tester@example.test', passwordHash: 'x', role: 'ADMIN' },
  });
  return user.id;
}

const parsed: Record<SpruceReportType, ParsedSpruceReport> = {
  ORDER_SUMMARY: parseSprucePages(orderSummaryReport()),
  DELIVERY: parseSprucePages(deliveryReport()),
  ITEM_TRACKING: parseSprucePages(itemTrackingReport()),
};

/** The three reports as uploaded; `stamp` stands in for different file bytes. */
function files(stamp = 'morning', overrides: Partial<Record<SpruceReportType, ParsedSpruceReport>> = {}): BatchFile[] {
  return (Object.keys(parsed) as SpruceReportType[]).map(reportType => ({
    reportType,
    fileName: `${reportType}.pdf`,
    buffer: Buffer.from(`${stamp}-${reportType}`),
    report: overrides[reportType] ?? parsed[reportType],
  }));
}

const document = (documentNumber: string) =>
  prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber }, include: { lines: true } });

/** Every order, line, correction and batch as stored, to prove a replay wrote nothing. */
const everything = async () => ({
  documents: await prisma.orderDocument.findMany({ orderBy: { documentNumber: 'asc' } }),
  lines: await prisma.order.findMany({ orderBy: { id: 'asc' } }),
  overrides: await prisma.orderOverride.findMany({ orderBy: { id: 'asc' } }),
  changes: await prisma.orderChange.count(),
  batches: await prisma.importBatch.findMany({ orderBy: { id: 'asc' } }),
});

describe('Spruce morning import (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    userId = await seedUser();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('merges the three reports into one order per document, each field from its own report', async () => {
    const summary = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });

    assert.equal(summary.alreadyImported, false);
    assert.equal(summary.deliveries, 2);
    assert.equal(summary.reports.length, 3);

    const first = await document('2608-700001');
    assert.equal(first.customerName, 'Priya Raman', 'the person from the delivery report');
    assert.equal(first.accountName, 'Cash Sales');
    assert.equal(first.phone, '519-555-0128');
    assert.equal(first.route, 'NORTH');
    assert.equal(first.cashier, 'TESTER', 'from the order summary');
    assert.equal(first.totalWithTax?.toString(), '118.65', 'the order summary\'s total before the delivery report\'s');
    assert.equal(first.shippingAddress, '14 Mill Race Rd.,');
    assert.equal(first.addressNormalized, '14 Mill Race Rd.');
    assert.deepEqual(first.sourceReports, ['DELIVERY', 'ITEM_TRACKING', 'ORDER_SUMMARY']);
    // The two reports print different totals, and the address has no town.
    assert.deepEqual(first.flags, ['CHECK_ADDRESS', 'TOTAL_MISMATCH']);
    assert.equal(first.lines.find(line => line.spruceItemNumber === 'SOILGRDNA')?.unitPrice?.toString(), '35');

    const second = await document('2608-700002');
    // The delivery report says 9/2 where the other two say 9/5: it is believed, and the
    // disagreement is flagged rather than hidden.
    assert.equal(second.deliveryDate?.toISOString().slice(0, 10), '2026-09-02');
    assert.ok(second.flags.includes('DATE_MISMATCH'));
    assert.ok(second.flags.includes('CUSTOMER_ON_SITE'));
    assert.ok(second.flags.includes('AWAITING_SUPPLIER'));
    assert.equal(second.isPickup, false, 'a dated order is a delivery whatever its address says');
    const withPo = second.lines.find(line => line.spruceItemNumber === 'RETURNCOMM');
    assert.equal(withPo?.vendorCode, 'STONECO01');
    assert.equal(withPo?.poValue?.toString(), '1204.55');
    assert.equal(withPo?.lineClass, 'COMMENT');

    const issues = summary.issues.map(issue => issue.documentNumber).sort();
    assert.deepEqual(issues, ['2608-700001', '2608-700002']);
  });

  it('answers an identical re-upload for the same day as already imported, changing nothing', async () => {
    const first = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });
    const stored = await everything();
    const again = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });

    assert.equal(again.alreadyImported, true);
    assert.equal(again.batchId, first.batchId);
    assert.equal(await prisma.importBatch.count(), 1);
    assert.equal(await prisma.order.count(), (await prisma.order.count({ where: { documentId: { not: null } } })));
    assert.deepEqual(await everything(), stored, 'not a row written');

    // Nothing changed, so the day reads as it did, and nothing is "updated".
    assert.equal(again.updated, 0);
    assert.deepEqual(
      { deliveries: again.deliveries, upcoming: again.upcoming, pickups: again.pickups, orders: again.orders, issues: again.issues },
      { deliveries: first.deliveries, upcoming: first.upcoming, pickups: first.pickups, orders: first.orders, issues: first.issues }
    );
    assert.deepEqual(again.warnings, first.warnings);
    assert.deepEqual(again.errors, first.errors);
    // The same files, but this upload wrote nothing from any of them.
    assert.deepEqual(
      again.reports.map(report => [report.reportType, report.rowCount, report.created, report.updated, report.unchanged]),
      first.reports.map(report => [report.reportType, report.rowCount, 0, 0, 0])
    );
  });

  it('describes the day as it is now when the same files come again after corrections', async () => {
    // No order summary: the only issue on 700001 is its address, which has no town.
    const deliveryAndTracking = files().filter(file => file.reportType !== 'ORDER_SUMMARY');
    const first = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: deliveryAndTracking });
    assert.deepEqual(first.issues.find(issue => issue.documentNumber === '2608-700001')?.flags, ['CHECK_ADDRESS']);
    assert.equal(first.deliveries, 2);
    assert.equal(first.upcoming, 0);

    // The dispatcher fixes the address and moves 700002 to the next day.
    const fixed = await document('2608-700001');
    await applyOrderEdits(fixed.id, parseEditRequest({ fields: { shippingAddress: '14 Mill Race Rd, Cambridge' } }), userId);
    const moved = await document('2608-700002');
    await applyOrderEdits(moved.id, parseEditRequest({ fields: { deliveryDate: '2026-09-03' } }), userId);
    const changesBefore = await prisma.orderChange.count();
    const stored = await everything();

    const again = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: deliveryAndTracking });

    assert.equal(again.alreadyImported, true);
    assert.equal(again.batchId, first.batchId);
    assert.ok(!again.issues.some(issue => issue.documentNumber === '2608-700001'), 'the fixed order is no longer an issue');
    assert.ok(!again.orders.find(order => order.documentNumber === '2608-700001')!.flags.includes('CHECK_ADDRESS'));
    assert.equal(again.deliveries, 1, 'the moved order is no longer out on 9/2');
    assert.equal(again.upcoming, 1);
    assert.equal(again.orders.find(order => order.documentNumber === '2608-700002')!.deliveryDate, '2026-09-03');
    assert.equal(again.updated, 0);

    // Still nothing written: the corrections stand, and no change is logged.
    assert.deepEqual(await everything(), stored);
    assert.equal(await prisma.orderChange.count(), changesBefore);
    assert.equal(await prisma.importBatch.count(), 1);
  });

  it('imports the same files again for another dispatch date', async () => {
    const first = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });
    const nextDay = await runImportBatch(prisma, { dispatchDate: '2026-09-03', createdById: userId, files: files() });

    assert.equal(nextDay.alreadyImported, false);
    assert.notEqual(nextDay.batchId, first.batchId);
    assert.equal(nextDay.dispatchDate, '2026-09-03');
    assert.equal(await prisma.importBatch.count(), 2);
    // The reports are for 9/2, and the screen says so.
    assert.ok(nextDay.warnings.some(warning => /not 9\/3/.test(warning)));
    assert.equal(nextDay.deliveries, 0, 'nothing goes out on 9/3');

    // And for that day, they are now already imported in turn.
    const again = await runImportBatch(prisma, { dispatchDate: '2026-09-03', createdById: userId, files: files() });
    assert.equal(again.alreadyImported, true);
    assert.equal(again.batchId, nextDay.batchId);
    assert.equal(await prisma.importBatch.count(), 2);
  });

  it('still answers already imported when the same day\'s files come back on a later calendar day', async () => {
    const first = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });
    await prisma.importBatch.update({
      where: { id: first.batchId },
      data: { createdAt: new Date('2026-09-02T11:00:00Z'), finishedAt: new Date('2026-09-02T11:01:00Z') },
    });
    const stored = await everything();

    const later = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });

    assert.equal(later.alreadyImported, true);
    assert.equal(later.batchId, first.batchId);
    assert.deepEqual(await everything(), stored);
  });

  it('a replay after a newer upload for the day reports what that newer upload left', async () => {
    await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });
    const shorter: ParsedSpruceReport = {
      ...parsed.DELIVERY,
      rows: parsed.DELIVERY.rows.filter(row => row.documentNumber === '2608-700001'),
    };
    // At noon 700002 is gone from the delivery report, and from the others.
    const noonFiles = files('noon', {
      DELIVERY: shorter,
      ORDER_SUMMARY: { ...parsed.ORDER_SUMMARY, rows: parsed.ORDER_SUMMARY.rows.filter(row => row.documentNumber === '2608-700001') },
      ITEM_TRACKING: { ...parsed.ITEM_TRACKING, rows: parsed.ITEM_TRACKING.rows.filter(row => row.documentNumber === '2608-700001') },
    });
    const noon = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: noonFiles });
    assert.ok(noon.issues.some(issue => issue.documentNumber === '2608-700002' && issue.flags.includes('NOT_IN_LATEST_REPORT')));

    // The noon files again: the dropped order is still an issue, read from the database.
    const noonAgain = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: noonFiles });
    assert.equal(noonAgain.alreadyImported, true);
    assert.equal(noonAgain.batchId, noon.batchId);
    assert.deepEqual(noonAgain.issues, noon.issues);

    // The morning files again are not applied over noon's: they are a slip,
    // and what they show is the day as noon left it.
    const stored = await everything();
    const morningAgain = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });
    assert.equal(morningAgain.alreadyImported, true);
    assert.deepEqual(await everything(), stored);
    assert.ok(
      morningAgain.orders.find(order => order.documentNumber === '2608-700002')!.flags.includes('NOT_IN_LATEST_REPORT')
    );
  });

  it('never disturbs a driver\'s work when the reports are run again', async () => {
    await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });
    const linesBefore = await prisma.order.count();
    const line = (await document('2608-700001')).lines[0]!;
    await prisma.order.update({ where: { id: line.id }, data: { deliveryStatus: 'IN_TRANSIT', priority: 7 } });

    await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files('noon') });

    const after = await prisma.order.findUniqueOrThrow({ where: { id: line.id } });
    assert.equal(after.deliveryStatus, 'IN_TRANSIT');
    assert.equal(after.priority, 7);
    assert.equal(await prisma.order.count(), linesBefore, 'no line duplicated');
    assert.equal(await prisma.importBatch.count(), 2);
  });

  it('flags an order a later delivery report leaves out, without deleting it, and clears it when it returns', async () => {
    await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });

    const shorter: ParsedSpruceReport = {
      ...parsed.DELIVERY,
      rows: parsed.DELIVERY.rows.filter(row => row.documentNumber === '2608-700001'),
    };
    const noon = await runImportBatch(prisma, {
      dispatchDate: '2026-09-02',
      createdById: userId,
      files: files('noon', { DELIVERY: shorter }),
    });

    const dropped = await document('2608-700002');
    assert.ok(dropped.flags.includes('NOT_IN_LATEST_REPORT'));
    // The other reports still carry a different date for it; it stays on its
    // day until a person moves it.
    assert.equal(dropped.deliveryDate?.toISOString().slice(0, 10), '2026-09-02');
    assert.ok(noon.issues.some(issue => issue.documentNumber === '2608-700002'));

    await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files('evening') });
    assert.ok(!(await document('2608-700002')).flags.includes('NOT_IN_LATEST_REPORT'));
  });

  it('refuses an upload without the delivery report, writing nothing', async () => {
    const withoutDelivery = files().filter(file => file.reportType !== 'DELIVERY');

    await assert.rejects(
      runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: withoutDelivery }),
      ImportBatchError
    );
    assert.equal(await prisma.importBatch.count(), 0);
    assert.equal(await prisma.orderDocument.count(), 0);
  });

  it('accepts two of three when the delivery report is one, and says what is missing', async () => {
    const twoOfThree = files().filter(file => file.reportType !== 'ITEM_TRACKING');

    const summary = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: twoOfThree });

    assert.ok(summary.warnings.some(warning => /No Item Tracking Report/.test(warning)));
    // Nothing reported where it goes: both deliveries need an address.
    assert.ok((await document('2608-700001')).flags.includes('NO_ADDRESS'));
  });
});
