// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { businessDayOf } from '../src/lib/businessDay.js';
import { DeliveriesService } from '../src/modules/deliveries/deliveries.service.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { parseEditRequest } from '../src/modules/orders/edits/editableFields.js';
import { applyOrderEdits, getOrderForEditing } from '../src/modules/orders/edits/orderEdits.service.js';
import { runImportBatch, type BatchFile } from '../src/modules/orders/import/importBatch.service.js';
import { updatesForDay } from '../src/modules/orders/import/orderChanges.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import type { ParsedSpruceReport, ParsedSpruceRow, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
import { deliveryReport, itemTrackingReport, orderSummaryReport } from './fixtures/spruceLayouts.js';

/**
 * The reports uploaded again later the same day, against PostgreSQL: what
 * Spruce changed on orders already imported is logged and marked "Updated",
 * a new order is only new, a dispatcher's correction still wins, and nothing
 * a driver is working from is disturbed or widened.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

const MONEY_KEYS = ['unitPrice', 'unitCost', 'poValue', 'totalWithTax', 'remaining', 'remainingDeposit', 'grossMarginPct', 'supplier'];

function keysIn(value: unknown, wanted: string[], path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => keysIn(item, wanted, `${path}[${index}]`));
  if (value === null || typeof value !== 'object' || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(wanted.includes(key) ? [`${path}.${key}`] : []),
    ...keysIn(child, wanted, `${path}.${key}`),
  ]);
}

const morning: Record<SpruceReportType, ParsedSpruceReport> = {
  ORDER_SUMMARY: parseSprucePages(orderSummaryReport()),
  DELIVERY: parseSprucePages(deliveryReport()),
  ITEM_TRACKING: parseSprucePages(itemTrackingReport()),
};

/** The same reports with rows edited, as Spruce prints them after a change. */
function changed(
  type: SpruceReportType,
  edit: (row: ParsedSpruceRow) => ParsedSpruceRow,
  extra: ParsedSpruceRow[] = []
): ParsedSpruceReport {
  const report = morning[type];
  return { ...report, rows: [...report.rows.map(row => edit({ ...row })), ...extra] };
}

/** Noon: one address, one quantity, one new line, the corrected phone, and one new order. */
function noonReports(): Record<SpruceReportType, ParsedSpruceReport> {
  const harrowgate = morning.DELIVERY.rows.find(row => row.documentNumber === '2608-700002')!;
  return {
    ORDER_SUMMARY: morning.ORDER_SUMMARY,
    ITEM_TRACKING: changed('ITEM_TRACKING', row =>
      row.documentNumber === '2608-700001' ? { ...row, shippingAddress: '22 Mill Race Rd., Cambridge' } : row
    ),
    DELIVERY: changed(
      'DELIVERY',
      row => {
        if (row.documentNumber === '2608-700001') return { ...row, phone: '519-555-0177' };
        if (row.itemNumber === 'AGG01') return { ...row, quantity: 44 };
        return row;
      },
      [
        { ...harrowgate, product: 'Polymeric Sand', itemNumber: 'PSSBL', quantity: 2, unit: 'BAG', source: { page: 1, row: 90 } },
        {
          ...harrowgate,
          documentNumber: '2608-700009',
          customerName: 'Newly Entered',
          product: 'Garden Soil Bulk',
          itemNumber: 'SOILGRDNA',
          quantity: 5,
          unit: 'CY',
          phone: '519-555-0300',
          source: { page: 1, row: 91 },
        },
      ]
    ),
  };
}

function files(stamp: string, reports: Record<SpruceReportType, ParsedSpruceReport>): BatchFile[] {
  return (Object.keys(reports) as SpruceReportType[]).map(reportType => ({
    reportType,
    fileName: `${reportType}.pdf`,
    buffer: Buffer.from(`${stamp}-${reportType}`),
    report: reports[reportType],
  }));
}

const documentId = async (documentNumber: string) =>
  (await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber }, select: { id: true } })).id;

const changesOf = async (documentNumber: string) =>
  (await prisma.orderChange.findMany({
    where: { document: { documentNumber } },
    orderBy: [{ createdAt: 'asc' }, { field: 'asc' }],
  })).map(change => ({ field: change.field, oldValue: change.oldValue, newValue: change.newValue, line: change.lineId !== null }));

describe('re-uploading the reports later the same day (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let userId: string;
  let driverId: string;
  const today = businessDayOf();
  const importAs = (stamp: string, reports: Record<SpruceReportType, ParsedSpruceReport>) =>
    runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files(stamp, reports) });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ImportBatch", "OrderDocument", "Order", "User", "Delivery", "Driver", "AuditLog" RESTART IDENTITY CASCADE'
    );
    userId = (await prisma.user.create({
      data: { name: 'Dispatcher', email: 'dispatcher-changes@example.test', passwordHash: 'x', role: 'ADMIN' },
    })).id;
    const driverUser = await prisma.user.create({
      data: { name: 'Driver', email: 'driver-changes@example.test', passwordHash: 'x', role: 'DRIVER' },
    });
    driverId = (await prisma.driver.create({ data: { name: 'Driver', phone: '519-555-0101', userId: driverUser.id } })).id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('logs what Spruce changed, marks it Updated, and leaves new orders, corrections and drivers alone', async () => {
    const first = await importAs('morning', morning);
    assert.equal(first.updated, 0, 'nothing existed before the first upload');
    assert.equal(await prisma.orderChange.count(), 0);

    // The morning's dispatch: 700001 is on a truck, and its phone was corrected.
    const riverbend = await documentId('2608-700001');
    await DispatchService.assignOrder(riverbend, driverId);
    await applyOrderEdits(riverbend, parseEditRequest({ fields: { phone: '519-555-0999' } }), userId);
    const stopBefore = await prisma.delivery.findUniqueOrThrow({ where: { documentId: riverbend } });
    const linesBefore = await prisma.order.findMany({ where: { documentId: riverbend }, orderBy: { id: 'asc' } });

    const noon = await importAs('noon', noonReports());

    // 1. The log.
    assert.equal(noon.updated, 2, '700001 and 700002; the new order is not counted');
    assert.deepEqual(await changesOf('2608-700001'), [
      // Logged with Spruce's values, though the dispatcher's correction stands.
      { field: 'phone', oldValue: '519-555-0128', newValue: '519-555-0177', line: false },
      { field: 'shippingAddress', oldValue: '14 Mill Race Rd.,', newValue: '22 Mill Race Rd., Cambridge', line: false },
    ]);
    assert.deepEqual(await changesOf('2608-700002'), [
      { field: 'lineAdded', oldValue: null, newValue: '2 BAG Polymeric Sand', line: true },
      { field: 'quantity', oldValue: '40', newValue: '44', line: true },
    ]);
    assert.deepEqual(await changesOf('2608-700009'), [], 'a brand-new order is new, not updated');
    const batchIds = new Set((await prisma.orderChange.findMany()).map(change => change.batchId));
    assert.deepEqual([...batchIds], [noon.batchId]);

    // 2. The correction holds, and Spruce's move is flagged rather than shown.
    const riverbendNow = await prisma.orderDocument.findUniqueOrThrow({ where: { id: riverbend } });
    assert.equal(riverbendNow.phone, '519-555-0999');
    assert.ok(riverbendNow.flags.includes('SPRUCE_VALUE_CHANGED'));

    // 3. The board. Its pool and the driver's run both carry the marks.
    const board = await DispatchService.getDispatchBoard('2026-09-02', today);
    const onRun = board.drivers.flatMap(driver => driver.deliveries).find(stop => stop.order.id === riverbend)!.order;
    assert.deepEqual('updatedFields' in onRun ? onRun.updatedFields : null, ['shippingAddress'], 'not the corrected phone');
    const harrowgate = board.unassignedOrders.find(order => order.spruceOrderId === '2608-700002')!;
    assert.deepEqual(harrowgate.updatedFields, ['quantity', 'lineAdded']);
    const fresh = board.unassignedOrders.find(order => order.spruceOrderId === '2608-700009')!;
    assert.deepEqual(fresh.updatedFields, []);
    assert.deepEqual(keysIn(board, MONEY_KEYS), [], 'no money on the board');

    // "Today" is the yard's day: yesterday's uploads mark nothing.
    assert.equal((await updatesForDay(prisma, [riverbend], '2026-01-01')).size, 0);

    // 4. The editor says what each updated field was.
    const editor = await getOrderForEditing('2608-700001', today);
    assert.deepEqual(editor.updatedFields, ['shippingAddress']);
    assert.equal(editor.updates[0]!.oldValue, '14 Mill Race Rd.,');
    assert.equal(editor.updates[0]!.newValue, '22 Mill Race Rd., Cambridge');
    const quantity = (await getOrderForEditing('2608-700002', today)).updates.find(update => update.field === 'quantity')!;
    assert.equal(quantity.oldValue, '40');
    assert.ok(quantity.lineId);

    // 5. The driver's work is untouched, and their stop is no wider.
    const stopAfter = await prisma.delivery.findUniqueOrThrow({ where: { documentId: riverbend } });
    assert.deepEqual(
      { driverId: stopAfter.driverId, status: stopAfter.status, priority: stopAfter.priority, orderId: stopAfter.orderId },
      { driverId: stopBefore.driverId, status: stopBefore.status, priority: stopBefore.priority, orderId: stopBefore.orderId }
    );
    const linesAfter = await prisma.order.findMany({ where: { documentId: riverbend }, orderBy: { id: 'asc' } });
    assert.deepEqual(
      linesAfter.map(line => [line.id, line.driverId, line.deliveryStatus]),
      linesBefore.map(line => [line.id, line.driverId, line.deliveryStatus])
    );

    const phone = await DeliveriesService.getCurrentStop(driverId);
    assert.equal(phone.data.length, 1);
    const stop = phone.data[0]!;
    assert.deepEqual(keysIn(phone, MONEY_KEYS), [], 'no money on the phone');
    assert.deepEqual(keysIn(phone, ['updatedFields', 'changes', 'updates', 'oldValue']), [], 'nothing new on the phone');
    assert.deepEqual(Object.keys(stop.document!).sort(), [
      '_count', 'addressNormalized', 'createdAt', 'customerName', 'deliveryDate', 'deliveryInstructions',
      'deliveryType', 'dispatcherNotes', 'documentNumber', 'flags', 'id', 'lines', 'phone', 'shippingAddress',
    ]);
  });

  it('logs nothing more when the same reports come round again, and a dropped line once', async () => {
    await importAs('morning', morning);
    await importAs('noon', noonReports());
    const afterNoon = await prisma.orderChange.count();

    const again = await importAs('afternoon', noonReports());
    assert.equal(again.updated, 0);
    assert.equal(await prisma.orderChange.count(), afterNoon, 'same values, nothing new to log');

    // Spruce takes the stone dust off 700002.
    const withoutDust = { ...noonReports() };
    withoutDust.DELIVERY = { ...withoutDust.DELIVERY, rows: withoutDust.DELIVERY.rows.filter(row => row.itemNumber !== 'AGGSTNEDUSTA') };
    const evening = await importAs('evening', withoutDust);
    assert.equal(evening.updated, 1);
    const removed = await prisma.orderChange.findMany({ where: { field: 'lineRemoved' } });
    assert.equal(removed.length, 1);
    assert.equal(removed[0]!.oldValue, '1 CY Agg Stone Dust YrdBlk 1CY');
    const dust = await prisma.order.findFirstOrThrow({ where: { spruceItemNumber: 'AGGSTNEDUSTA' } });
    assert.equal(removed[0]!.lineId, dust.id, 'the line itself stays, in case it is on a ticket');

    await importAs('late', withoutDust);
    assert.equal(await prisma.orderChange.count({ where: { field: 'lineRemoved' } }), 1, 'logged once');

    const editor = await getOrderForEditing('2608-700002', today);
    assert.deepEqual(editor.updatedFields, ['quantity', 'lineAdded', 'lineRemoved']);
  });

  it('goes with its order', async () => {
    await importAs('morning', morning);
    await importAs('noon', noonReports());
    assert.ok((await prisma.orderChange.count()) > 0);

    await prisma.$executeRawUnsafe('TRUNCATE TABLE "OrderDocument" CASCADE');
    assert.equal(await prisma.orderChange.count(), 0);
  });
});
