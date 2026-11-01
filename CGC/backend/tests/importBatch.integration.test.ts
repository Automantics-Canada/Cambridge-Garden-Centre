// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { parseEditRequest } from '../src/modules/orders/edits/editableFields.js';
import { applyOrderEdits } from '../src/modules/orders/edits/orderEdits.service.js';
import { ImportBatchError, runImportBatch, type BatchFile } from '../src/modules/orders/import/importBatch.service.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import type { ParsedSpruceReport, ParsedSpruceRow, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
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
    // Every delivery in the upload is on today's board, whatever its date.
    assert.equal(summary.onBoard, summary.orders.filter(order => !order.isPickup).length);
    assert.ok(summary.onBoard! > 0);
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

  describe('the AI double-check', () => {
    // Explicit messages throughout: a bare assert.ok that fails under tsx hangs
    // while Node rebuilds its message from the transformed source.
    const checked = (aiCheck: ParsedSpruceReport['aiCheck']): ParsedSpruceReport => ({ ...parsed.DELIVERY, aiCheck });
    const customerDiffers = {
      status: 'differences' as const,
      compared: 5,
      agreed: 3,
      differences: [{ documentNumber: '2608-700001', detail: 'customer read as "Priya Raman" by the report reader, "U/M" by AI' }],
    };
    const flagged = async (documentNumber: string) => (await document(documentNumber)).flags.includes('READ_DIFFERENTLY');

    it('flags the order the two readings differ on, says what differs, and clears it when they next agree', async () => {
      const morning = await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('morning', { DELIVERY: checked(customerDiffers) }),
      });

      assert.equal(await flagged('2608-700001'), true, 'the order the readings differ on is flagged');
      assert.equal(await flagged('2608-700002'), false, 'the order they agree on is not');
      assert.deepEqual(
        morning.issues.filter(issue => issue.flags.includes('READ_DIFFERENTLY')).map(issue => issue.documentNumber),
        ['2608-700001']
      );
      assert.deepEqual(morning.warnings.filter(warning => /AI double-check|read as/.test(warning)), [
        'AI double-check: the Delivery Report reads differently in 1 order. Check it against the report:',
        '2608-700001: customer read as "Priya Raman" by the report reader, "U/M" by AI',
      ]);
      assert.deepEqual(morning.aiChecks, [{
        reportType: 'DELIVERY', label: 'Delivery Report', status: 'differences', compared: 5, agreed: 3, ordersDiffering: 1, reason: null,
      }]);
      // The layout reader's reading is the one stored.
      assert.equal((await document('2608-700001')).customerName, 'Priya Raman');

      await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('noon', { DELIVERY: checked({ status: 'agreed', compared: 5, agreed: 5, differences: [] }) }),
      });
      assert.equal(await flagged('2608-700001'), false, 'cleared when the readings next agree');
    });

    it('keeps an earlier finding when a later check could not run, and says it did not', async () => {
      await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('morning', { DELIVERY: checked(customerDiffers) }),
      });

      const noon = await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('noon', {
          DELIVERY: checked({ status: 'unavailable', compared: 0, agreed: 0, differences: [], reason: 'the AI account is out of credit' }),
        }),
      });

      assert.equal(await flagged('2608-700001'), true, 'an unchecked upload decides nothing');
      assert.deepEqual(noon.warnings.filter(warning => /AI double-check/.test(warning)), [
        'The AI double-check of the Delivery Report did not run: the AI account is out of credit. It was imported as the report reader read it.',
      ]);
      assert.equal(noon.aiChecks?.[0]?.status, 'unavailable');
    });

    it('clears the flag once a dispatcher has corrected the order', async () => {
      await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('morning', { DELIVERY: checked(customerDiffers) }),
      });

      await applyOrderEdits((await document('2608-700001')).id, parseEditRequest({ fields: { customerName: 'Priya Raman (checked)' } }), userId);

      assert.equal(await flagged('2608-700001'), false, "a dispatcher's edit acknowledges the flag");
    });

    it('says when the AI could not read a report, and that the report reader did', async () => {
      const summary = await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('morning', { DELIVERY: { ...parsed.DELIVERY, readBy: 'PARSER', aiFailed: 'the AI account is out of credit' } }),
      });

      assert.deepEqual(summary.warnings.filter(warning => /AI could not read/.test(warning)), [
        'The AI could not read the Delivery Report: the AI account is out of credit. The report reader read it instead. ' +
          'Check its orders before dispatch.',
      ]);
      assert.equal((await document('2608-700001')).customerName, 'Priya Raman', 'imported as the report reader read it');
    });

    it('says nothing about who read a report when the AI read it as configured', async () => {
      const summary = await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('morning', { DELIVERY: { ...parsed.DELIVERY, readBy: 'AI' } }),
      });

      assert.deepEqual(summary.warnings.filter(warning => /AI/.test(warning)), []);
    });

    it('says when a report was read by the AI alone, why, and when the developer is needed', async () => {
      const summary = await runImportBatch(prisma, {
        dispatchDate: '2026-09-02',
        createdById: userId,
        files: files('morning', { DELIVERY: { ...parsed.DELIVERY, readBy: 'AI', readByAiBecause: 'its layout was not recognised' } }),
      });

      assert.deepEqual(summary.warnings.filter(warning => /read by AI alone/.test(warning)), [
        'The Delivery Report was read by AI alone, because its layout was not recognised. Check its orders before dispatch. ' +
          'Tell your developer, so the report reader can be updated for it.',
      ]);
    });
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
    assert.ok((await document('2608-700001')).flags.includes('NOT_IN_ITEM_TRACKING'), 'no address, because the Item Tracking report was not uploaded');
  });
});

/** A report's rows under another (invented) document number, with changes. */
const renumbered = (rows: ParsedSpruceRow[], from: string, to: string, extra: Partial<ParsedSpruceRow> = {}) =>
  rows.filter(row => row.documentNumber === from).map(row => ({ ...row, documentNumber: to, ...extra }));

const dated = (report: ParsedSpruceReport, fromRaw: string, toRaw = fromRaw): ParsedSpruceReport => ({
  ...report,
  dateRange: { fromRaw, toRaw },
});

describe('a rolling Item Tracking export and quotations (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let userId: string;
  const run = (dispatchDate: string, stamp: string, reports: Partial<Record<SpruceReportType, ParsedSpruceReport>>) =>
    runImportBatch(prisma, {
      dispatchDate,
      createdById: userId,
      files: (Object.keys(reports) as SpruceReportType[]).map(reportType => ({
        reportType,
        fileName: `${reportType}.pdf`,
        buffer: Buffer.from(`${stamp}-${reportType}`),
        report: reports[reportType]!,
      })),
    });
  const flagsOf = async (documentNumber: string) => (await document(documentNumber)).flags;

  beforeEach(async () => {
    await resetDatabase();
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Delivery", "Driver" RESTART IDENTITY CASCADE');
    userId = await seedUser();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('uses a month of Item Tracking only for the day: older orders are not re-dated, re-described, created or touched', async () => {
    // 8/12: an order entered 8/10, delivered that day; the dispatcher fixed its address.
    const first = await run('2026-08-12', 'aug12', {
      DELIVERY: dated({
        ...parsed.DELIVERY,
        rows: renumbered(parsed.DELIVERY.rows, '2608-700001', '2608-690001', { deliveryDateRaw: '08/12/26' }),
      }, '08/12/26'),
      ITEM_TRACKING: {
        ...parsed.ITEM_TRACKING,
        rows: renumbered(parsed.ITEM_TRACKING.rows, '2608-700001', '2608-690001', { orderDateRaw: '8/10/2026' }),
      },
    });
    const old = await document('2608-690001');
    await applyOrderEdits(old.id, parseEditRequest({ fields: { shippingAddress: '9 Old Quarry Rd, Cambridge' } }), userId);
    const before = await document('2608-690001');
    const changesBefore = await prisma.orderChange.count({ where: { documentId: old.id } });

    // 9/2: Item Tracking now runs from 8/1, so it lists the old order again
    // (with another date and wording) and one never imported at all.
    const wide: ParsedSpruceReport = dated({
      ...parsed.ITEM_TRACKING,
      rows: [
        ...parsed.ITEM_TRACKING.rows,
        ...renumbered(parsed.ITEM_TRACKING.rows, '2608-700001', '2608-690001', {
          orderDateRaw: '8/10/2026', deliveryDateRaw: '9/9/2026', product: 'Garden Soil Bulk Premium', shippingAddress: '1 Other St, Ayr',
        }),
        ...renumbered(parsed.ITEM_TRACKING.rows, '2608-700001', '2608-690002', { orderDateRaw: '8/11/2026', deliveryDateRaw: '9/2/2026' }),
      ],
    }, '8/1/2026', '9/2/2026');
    const today = {
      ORDER_SUMMARY: dated(parsed.ORDER_SUMMARY, '09/02/26'),
      DELIVERY: parsed.DELIVERY,
      ITEM_TRACKING: wide,
    };
    const summary = await run('2026-09-02', 'sep2', today);

    assert.equal(await prisma.orderDocument.count({ where: { documentNumber: '2608-690002' } }), 0, 'an older order is never created');
    const after = await document('2608-690001');
    assert.equal(after.deliveryDate?.toISOString().slice(0, 10), '2026-08-12', 'not re-dated');
    assert.equal(after.lastBatchId, first.batchId, 'not part of today\'s upload, so not in today\'s pool');
    assert.equal(after.shippingAddress, '9 Old Quarry Rd, Cambridge', "the dispatcher's correction stands");
    assert.deepEqual(after.lines.map(line => [line.id, line.product, line.deliveryDate?.toISOString()]),
      before.lines.map(line => [line.id, line.product, line.deliveryDate?.toISOString()]), 'not re-described');
    assert.deepEqual(after.flags, before.flags);
    assert.equal(await prisma.orderChange.count({ where: { documentId: old.id } }), changesBefore, 'nothing marked Updated');
    assert.equal(await prisma.orderOverride.count({ where: { documentId: old.id } }), 1);

    assert.ok(!summary.orders.some(order => order.documentNumber.startsWith('2608-6900')));
    assert.deepEqual(summary.itemTracking, { documentsRead: 4, documentsUsed: 2, dateFrom: '2026-08-01', dateTo: '2026-09-02' });
    // What is stored for the upload is what it used.
    const stored = await prisma.importBatchFile.findFirstOrThrow({ where: { batchId: summary.batchId, reportType: 'ITEM_TRACKING' } });
    const extraction = stored.extraction as { rows: ParsedSpruceRow[]; scope: unknown };
    assert.deepEqual([...new Set(extraction.rows.map(row => row.documentNumber))].sort(), ['2608-700001', '2608-700002']);
    assert.deepEqual(extraction.scope, summary.itemTracking);

    // The same reports again at noon: no duplicates, nothing new.
    const counts = { documents: await prisma.orderDocument.count(), lines: await prisma.order.count() };
    await run('2026-09-02', 'sep2-noon', today);
    assert.deepEqual({ documents: await prisma.orderDocument.count(), lines: await prisma.order.count() }, counts);
  });

  it('says when today\'s deliveries are missing from Item Tracking, and where it starts', async () => {
    const summary = await run('2026-09-02', 'sep2', {
      ORDER_SUMMARY: dated(parsed.ORDER_SUMMARY, '09/02/26'),
      DELIVERY: parsed.DELIVERY,
      ITEM_TRACKING: dated({
        ...parsed.ITEM_TRACKING,
        rows: parsed.ITEM_TRACKING.rows.filter(row => row.documentNumber !== '2608-700001'),
      }, '9/1/2026', '9/2/2026'),
    });

    assert.ok((await flagsOf('2608-700001')).includes('NOT_IN_ITEM_TRACKING'));
    assert.deepEqual(summary.warnings.filter(warning => /not in the Item Tracking Report/.test(warning)), [
      '1 delivery on the Delivery Report is not in the Item Tracking Report (it starts 9/1), so it has no address. ' +
        'Export Item Tracking from an earlier date.',
    ]);
  });

  it('recognises a quotation, keeps it through a wider Item Tracking, and lets it come back as an order', async () => {
    // 700009: on Item Tracking only, entered on the Order Report's day, no PO.
    // 700008: the same, but with a supplier PO: an order closed since.
    const tracking = (range: [string, string]) => dated({
      ...parsed.ITEM_TRACKING,
      rows: [
        ...parsed.ITEM_TRACKING.rows,
        ...renumbered(parsed.ITEM_TRACKING.rows, '2608-700001', '2608-700009', { orderDateRaw: '9/2/2026', deliveryDateRaw: '9/2/2026' }),
        ...renumbered(parsed.ITEM_TRACKING.rows, '2608-700001', '2608-700008', { orderDateRaw: '9/2/2026', poNumber: '2608-300008' }),
      ],
    }, ...range);

    const morning = await run('2026-09-02', 'sep2', {
      ORDER_SUMMARY: dated(parsed.ORDER_SUMMARY, '09/02/26'),
      DELIVERY: parsed.DELIVERY,
      ITEM_TRACKING: tracking(['9/2/2026', '9/2/2026']),
    });

    const quote = await document('2608-700009');
    assert.ok(quote.flags.includes('QUOTE'));
    assert.ok(!quote.flags.includes('NOT_OPEN'));
    assert.equal(quote.isPickup, false);
    assert.deepEqual(quote.flags, ['QUOTE'], 'and no delivery checks on it');
    const closed = await flagsOf('2608-700008');
    assert.ok(closed.includes('NOT_OPEN') && !closed.includes('QUOTE'), 'a PO means it was an order');

    assert.equal(morning.quotes, 1);
    assert.deepEqual(morning.quoteNumbers, ['2608-700009']);
    assert.ok(!morning.orders.some(order => order.documentNumber === '2608-700009'));
    assert.ok(!morning.issues.some(issue => issue.documentNumber === '2608-700009'));
    assert.equal(morning.deliveries, 2, 'the quotation dated today is not a delivery');
    assert.equal(morning.onBoard, morning.orders.filter(order => !order.isPickup && !order.flags.includes('NOT_OPEN')).length);

    // 9/3: the Order Report is for 9/3, and Item Tracking reaches back to 9/1.
    const nextDay = await run('2026-09-03', 'sep3', {
      ORDER_SUMMARY: dated(parsed.ORDER_SUMMARY, '09/03/26'),
      DELIVERY: parsed.DELIVERY,
      ITEM_TRACKING: tracking(['9/1/2026', '9/3/2026']),
    });
    assert.deepEqual(await flagsOf('2608-700009'), ['QUOTE'], 'still a quotation');
    assert.ok((await flagsOf('2608-700008')).includes('NOT_OPEN'), 'still closed');
    assert.ok(!nextDay.orders.some(order => order.documentNumber === '2608-700009'));

    // 9/4: the quotation was converted, and the Order Report lists it.
    await run('2026-09-04', 'sep4', {
      ORDER_SUMMARY: dated({
        ...parsed.ORDER_SUMMARY,
        rows: [...parsed.ORDER_SUMMARY.rows, ...renumbered(parsed.ORDER_SUMMARY.rows, '2608-700001', '2608-700009')],
      }, '09/04/26'),
      DELIVERY: parsed.DELIVERY,
      ITEM_TRACKING: tracking(['9/1/2026', '9/4/2026']),
    });
    const converted = await flagsOf('2608-700009');
    assert.ok(!converted.includes('QUOTE') && !converted.includes('NOT_OPEN'), 'an order now');
  });

  it('never takes an order for a quotation because one of its Order Report lines could not be read', async () => {
    await run('2026-09-02', 'sep2', {
      ORDER_SUMMARY: {
        ...dated(parsed.ORDER_SUMMARY, '09/02/26'),
        unreadable: [{ page: 1, row: 30, reason: 'could not read the quantity for document 2608-700009', documentNumber: '2608-700009' }],
      },
      DELIVERY: parsed.DELIVERY,
      ITEM_TRACKING: {
        ...parsed.ITEM_TRACKING,
        rows: [...parsed.ITEM_TRACKING.rows, ...renumbered(parsed.ITEM_TRACKING.rows, '2608-700001', '2608-700009', { orderDateRaw: '9/2/2026' })],
      },
    });

    const flags = await flagsOf('2608-700009');
    assert.ok(!flags.includes('QUOTE') && !flags.includes('NOT_OPEN'), `flags: ${flags.join(', ')}`);
  });

  it('asks for a phone only on orders that have been on a Delivery Report', async () => {
    // 700011 is dated by the Order Report and on no Delivery Report yet;
    // 700002's Delivery Report line prints no phone.
    await run('2026-09-02', 'sep2', {
      ORDER_SUMMARY: {
        ...parsed.ORDER_SUMMARY,
        rows: [...parsed.ORDER_SUMMARY.rows, ...renumbered(parsed.ORDER_SUMMARY.rows, '2608-700002', '2608-700011')],
      },
      DELIVERY: {
        ...parsed.DELIVERY,
        rows: parsed.DELIVERY.rows.map(row => (row.documentNumber === '2608-700002' ? { ...row, phone: undefined } : row)),
      },
      ITEM_TRACKING: parsed.ITEM_TRACKING,
    });

    assert.ok(!(await flagsOf('2608-700011')).includes('NO_PHONE'), 'not missing: nothing could have given it one');
    assert.ok((await flagsOf('2608-700002')).includes('NO_PHONE'));
  });

  it('refreshes an order with identical loads after it has been given to a driver', async () => {
    // 700002 carries the same 40 MT load twice.
    const load = parsed.DELIVERY.rows.find(row => row.documentNumber === '2608-700002' && row.itemNumber === 'AGG01')!;
    const twoLoads: ParsedSpruceReport = {
      ...parsed.DELIVERY,
      rows: parsed.DELIVERY.rows.flatMap(row => (row === load ? [row, { ...row, source: { ...row.source, row: row.source.row + 50 } }] : [row])),
    };
    await run('2026-09-02', 'morning', { DELIVERY: twoLoads });
    const order = await document('2608-700002');
    assert.equal(order.lines.filter(line => line.spruceItemNumber === 'AGG01').length, 2);
    const driver = await prisma.driver.create({ data: { name: 'Test Driver', phone: '519-555-0199' } });
    await DispatchService.assignOrder(order.id, driver.id);

    const noon = await run('2026-09-02', 'noon', { DELIVERY: twoLoads, ITEM_TRACKING: parsed.ITEM_TRACKING });

    assert.deepEqual(noon.errors.filter(error => /matched safely/.test(error)), [], 'the document is no longer refused');
    const after = await document('2608-700002');
    const loads = (lines: Array<{ id: string; spruceItemNumber: string | null }>) =>
      lines.filter(line => line.spruceItemNumber === 'AGG01').map(line => line.id).sort();
    assert.deepEqual(loads(after.lines), loads(order.lines), 'the same two loads, none duplicated');
    assert.ok(after.lines.filter(line => line.spruceItemNumber === 'AGG01').every(line => line.driverId === driver.id), 'still with the driver');
    assert.ok(after.sourceReports.includes('ITEM_TRACKING'), 'refreshed from the noon reports');
    assert.equal((await prisma.delivery.findUniqueOrThrow({ where: { documentId: order.id } })).driverId, driver.id);
  });
});
