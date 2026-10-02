// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
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

  it('answers an identical re-upload with what it found before, changing nothing', async () => {
    const first = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });
    const again = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files() });

    assert.equal(again.alreadyImported, true);
    assert.equal(again.batchId, first.batchId);
    assert.equal(await prisma.importBatch.count(), 1);
    assert.equal(await prisma.order.count(), (await prisma.order.count({ where: { documentId: { not: null } } })));
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
