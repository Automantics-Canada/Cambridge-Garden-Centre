// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { applyQuoteFlags, planQuoteFlags } from '../src/scripts/flagQuotes.js';

/**
 * The quotation backfill against PostgreSQL: the dry run's plan writes
 * nothing, an apply writes only what was planned (and only the allowlist when
 * one is given), and a document changed since the plan is left alone.
 * Every value is invented.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

async function seed(
  documentNumber: string,
  data: { sourceReports: string[]; flags?: string[]; line?: Record<string, unknown>; entered?: string }
) {
  return prisma.orderDocument.create({
    data: {
      documentNumber,
      customerName: 'Synthetic Customer',
      sourceReports: data.sourceReports,
      flags: data.flags ?? [],
      isPickup: true,
      orderDate: new Date(`${data.entered ?? '2026-09-02'}T00:00:00Z`),
      lines: {
        create: [{
          spruceOrderId: `${documentNumber}-L1`,
          lineNumber: 1,
          customerName: 'Synthetic Customer',
          product: 'Garden Soil Bulk',
          quantity: '1',
          ...(data.line ?? {}),
        }],
      },
    },
  });
}

/**
 * An upload as the import stores it: its Order Report's printed range, and
 * the documents its Item Tracking kept. `unreadable` are documents the Order
 * Report named on a line it could not read.
 */
async function upload(day: string, range: { from: string; to: string } | null, onTracking: string[], unreadable: string[] = []) {
  const userId = (await prisma.user.upsert({
    where: { email: 'backfill@example.test' },
    update: {},
    create: { name: 'Backfill', email: 'backfill@example.test', passwordHash: 'x', role: 'ADMIN' },
  })).id;
  const file = (reportType: string, extraction: object, dates: { from: string; to: string } | null) => ({
    reportType,
    fileName: `${reportType}.pdf`,
    fileHash: `${day}-${reportType}`,
    pageCount: 1,
    reportDateFrom: dates ? new Date(`${dates.from}T00:00:00Z`) : null,
    reportDateTo: dates ? new Date(`${dates.to}T00:00:00Z`) : null,
    rowCount: 0,
    documentCount: 0,
    unreadableCount: unreadable.length,
    extraction,
  });
  await prisma.importBatch.create({
    data: {
      dispatchDate: new Date(`${day}T00:00:00Z`),
      status: 'DONE',
      createdById: userId,
      files: {
        create: [
          file('ORDER_SUMMARY', { rows: [], unreadable: unreadable.map(documentNumber => ({ page: 1, row: 1, reason: 'x', documentNumber })) }, range),
          file('ITEM_TRACKING', { rows: onTracking.map(documentNumber => ({ documentNumber })), unreadable: [] }, null),
        ],
      },
    },
  });
}

const flagsOf = async (documentNumber: string) =>
  prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber }, select: { flags: true, isPickup: true } });

describe('flagging stored quotations (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ImportBatch", "User", "OrderDocument", "Order", "Delivery", "Driver" RESTART IDENTITY CASCADE'
    );
    await seed('9900-000001', { sourceReports: ['ITEM_TRACKING'], flags: ['NOT_OPEN'] });
    await seed('9900-000002', { sourceReports: ['ITEM_TRACKING'], entered: '2026-09-01' });
    await seed('9900-000003', { sourceReports: ['DELIVERY', 'ITEM_TRACKING'] });
    await seed('9900-000004', { sourceReports: ['ITEM_TRACKING'], line: { poNumber: '9900-300004' } });
    await seed('9900-000005', { sourceReports: ['ITEM_TRACKING'], line: { hasInvoice: true } });
    await seed('9900-000006', { sourceReports: ['ITEM_TRACKING'], flags: ['QUOTE'] });
    // Entered before the Order Report's range: an order still open looks the same.
    await seed('9900-000007', { sourceReports: ['ITEM_TRACKING'], entered: '2026-08-15' });
    // On Item Tracking only in an upload with no Order Report range.
    await seed('9900-000008', { sourceReports: ['ITEM_TRACKING'] });
    // Named on an Order Report line that could not be read.
    await seed('9900-000009', { sourceReports: ['ITEM_TRACKING'] });
    // The office said it is an order.
    await seed('9900-000010', { sourceReports: ['ITEM_TRACKING'], flags: ['NOT_OPEN', 'NOT_A_QUOTE'] });

    const all = ['9900-000001', '9900-000002', '9900-000003', '9900-000004', '9900-000005', '9900-000006', '9900-000007', '9900-000009', '9900-000010'];
    await upload('2026-09-02', { from: '2026-09-01', to: '2026-09-02' }, all, ['9900-000009']);
    await upload('2026-09-03', null, ['9900-000008']);
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('plans only Item-Tracking-only documents with no history, entered inside an Order Report range, and writes nothing', async () => {
    const before = await prisma.orderDocument.findMany({ orderBy: { documentNumber: 'asc' } });
    const plan = await planQuoteFlags(prisma);

    assert.deepEqual(plan.flag.map(item => [item.documentNumber, item.orderDate, item.before, item.after]), [
      ['9900-000001', '2026-09-02', ['NOT_OPEN'], ['QUOTE']],
      ['9900-000002', '2026-09-01', [], ['QUOTE']],
    ]);
    assert.deepEqual(plan.flag[0]!.coverage, [{ dispatchDate: '2026-09-02', from: '2026-09-01', to: '2026-09-02' }]);
    assert.equal(plan.flag[0]!.isPickup, true, 'printed, so it can be checked after an undo');
    // Left alone, and listed so a person sees why.
    assert.deepEqual(plan.notJudged.map(item => [item.documentNumber, item.coverage.length]), [
      ['9900-000007', 1],
      ['9900-000008', 0],
      ['9900-000009', 0],
    ]);
    assert.deepEqual(await prisma.orderDocument.findMany({ orderBy: { documentNumber: 'asc' } }), before);
  });

  it('writes only the allowlist when one is given, and then the rest', async () => {
    const result = await applyQuoteFlags(prisma, (await planQuoteFlags(prisma, ['9900-000001'])).flag);

    assert.deepEqual(result, { written: 1, skipped: [] });
    assert.deepEqual(await flagsOf('9900-000001'), { flags: ['QUOTE'], isPickup: false });
    assert.deepEqual(await flagsOf('9900-000002'), { flags: [], isPickup: true });

    await applyQuoteFlags(prisma, (await planQuoteFlags(prisma)).flag);
    assert.deepEqual(await flagsOf('9900-000002'), { flags: ['QUOTE'], isPickup: false });
    assert.deepEqual((await planQuoteFlags(prisma)).flag, [], 'a second run finds nothing left');
    for (const untouched of ['9900-000003', '9900-000004', '9900-000005', '9900-000007', '9900-000008', '9900-000009', '9900-000010']) {
      assert.ok(!(await flagsOf(untouched)).flags.includes('QUOTE'), untouched);
    }
  });

  it('leaves a document whose flags changed after the plan was made', async () => {
    const plan = (await planQuoteFlags(prisma)).flag;
    await prisma.orderDocument.update({ where: { documentNumber: '9900-000002' }, data: { flags: ['NOT_IN_LATEST_REPORT'] } });

    const result = await applyQuoteFlags(prisma, plan);

    assert.deepEqual(result, { written: 1, skipped: ['9900-000002'] });
    assert.deepEqual((await flagsOf('9900-000002')).flags, ['NOT_IN_LATEST_REPORT']);
  });
});

describe('undoing the backfill (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it('is undone by "Not a quotation", isPickup included, and a second run leaves the document alone', async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ImportBatch", "User", "OrderDocument", "Order", "Delivery", "Driver", "AuditLog" RESTART IDENTITY CASCADE'
    );
    await seed('9900-000001', { sourceReports: ['ITEM_TRACKING'], flags: ['NOT_OPEN'] });
    await upload('2026-09-02', { from: '2026-09-01', to: '2026-09-02' }, ['9900-000001']);
    await applyQuoteFlags(prisma, (await planQuoteFlags(prisma)).flag);
    assert.deepEqual(await flagsOf('9900-000001'), { flags: ['QUOTE'], isPickup: false });

    const { markNotQuotation } = await import('../src/modules/orders/edits/orderEdits.service.js');
    const { id } = await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber: '9900-000001' } });
    const userId = (await prisma.user.findFirstOrThrow()).id;
    await markNotQuotation(id, userId);

    // Undated, uncharged: a pickup again, as it was.
    assert.deepEqual(await flagsOf('9900-000001'), { flags: ['NOT_A_QUOTE'], isPickup: true });
    assert.deepEqual(await planQuoteFlags(prisma), { flag: [], notJudged: [] });
  });
});
