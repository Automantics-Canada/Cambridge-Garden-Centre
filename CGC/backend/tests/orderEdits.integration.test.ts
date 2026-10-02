// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { parseEditRequest } from '../src/modules/orders/edits/editableFields.js';
import {
  applyOrderEdits,
  getOrderForEditing,
  resetOrderEdit,
} from '../src/modules/orders/edits/orderEdits.service.js';
import { runImportBatch, type BatchFile } from '../src/modules/orders/import/importBatch.service.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import type { ParsedSpruceReport, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
import { deliveryReport, itemTrackingReport, orderSummaryReport } from './fixtures/spruceLayouts.js';

/**
 * A dispatcher's corrections against PostgreSQL, through real imports: they
 * show everywhere, survive the reports being run again, record what Spruce
 * says meanwhile, and can be undone.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

const parsed: Record<SpruceReportType, ParsedSpruceReport> = {
  ORDER_SUMMARY: parseSprucePages(orderSummaryReport()),
  DELIVERY: parseSprucePages(deliveryReport()),
  ITEM_TRACKING: parseSprucePages(itemTrackingReport()),
};

function files(stamp: string, only: SpruceReportType[] = ['ORDER_SUMMARY', 'DELIVERY', 'ITEM_TRACKING']): BatchFile[] {
  return only.map(reportType => ({
    reportType,
    fileName: `${reportType}.pdf`,
    buffer: Buffer.from(`${stamp}-${reportType}`),
    report: parsed[reportType],
  }));
}

const order = (documentNumber: string) =>
  prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber }, include: { lines: true, overrides: true } });

describe('correcting an order (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let userId: string;
  const importDay = (stamp: string, only?: SpruceReportType[]) =>
    runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: userId, files: files(stamp, only) });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ImportBatch", "OrderDocument", "Order", "User", "Delivery", "Driver", "AuditLog" RESTART IDENTITY CASCADE'
    );
    userId = (await prisma.user.create({
      data: { name: 'Dispatcher', email: 'dispatcher@example.test', passwordHash: 'x', role: 'ADMIN' },
    })).id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('fills a missing address, clears the flag, and keeps it through a re-upload that has none', async () => {
    // No item tracking report: nothing says where the orders go.
    await importDay('morning', ['ORDER_SUMMARY', 'DELIVERY']);
    const before = await order('2608-700001');
    assert.ok(before.flags.includes('NO_ADDRESS'));

    await applyOrderEdits(before.id, parseEditRequest({ fields: { shippingAddress: '14 Mill Race Rd, Cambridge' } }), userId);

    let after = await order('2608-700001');
    assert.equal(after.shippingAddress, '14 Mill Race Rd, Cambridge');
    assert.equal(after.addressNormalized, '14 Mill Race Rd, Cambridge');
    assert.ok(!after.flags.includes('NO_ADDRESS'), 'a filled address clears the flag');
    assert.equal(await prisma.auditLog.count({ where: { actionType: 'ORDER_EDITED' } }), 1);

    await importDay('noon', ['ORDER_SUMMARY', 'DELIVERY']);
    after = await order('2608-700001');
    assert.equal(after.shippingAddress, '14 Mill Race Rd, Cambridge', 'the re-upload did not undo it');
    assert.ok(!after.flags.includes('NO_ADDRESS'));
    assert.ok(!after.flags.includes('SPRUCE_VALUE_CHANGED'), 'Spruce still says nothing, so nothing changed');
  });

  it('records a different value Spruce sends later, keeps the correction, and flags it', async () => {
    await importDay('morning', ['ORDER_SUMMARY', 'DELIVERY']);
    const id = (await order('2608-700001')).id;
    await applyOrderEdits(id, parseEditRequest({ fields: { shippingAddress: '14 Mill Race Rd, Cambridge' } }), userId);

    // Now the item tracking report arrives, and Spruce has an address of its own.
    await importDay('noon');

    const after = await order('2608-700001');
    assert.equal(after.shippingAddress, '14 Mill Race Rd, Cambridge');
    assert.ok(after.flags.includes('SPRUCE_VALUE_CHANGED'));
    const [override] = after.overrides;
    assert.equal(override!.spruceValue, '14 Mill Race Rd.,');
    assert.equal(override!.spruceValueAtEdit, null);
    assert.equal(override!.spruceChanged, true);

    const editor = await getOrderForEditing('2608-700001');
    assert.equal(editor.overrides[0]!.editedBy.name, 'Dispatcher');
  });

  it('puts Spruce\'s value back on reset, with what follows from it', async () => {
    await importDay('morning');
    const id = (await order('2608-700001')).id;
    await applyOrderEdits(id, parseEditRequest({ fields: { shippingAddress: '14 Mill Race Rd, Cambridge' } }), userId);
    assert.ok(!(await order('2608-700001')).flags.includes('CHECK_ADDRESS'));

    await resetOrderEdit(id, 'shippingAddress', null, userId);

    const after = await order('2608-700001');
    assert.equal(after.shippingAddress, '14 Mill Race Rd.,');
    assert.equal(after.overrides.length, 0);
    assert.ok(after.flags.includes('CHECK_ADDRESS'), 'Spruce\'s address has no town, so it is flagged again');
    assert.equal(await prisma.auditLog.count({ where: { actionType: 'ORDER_EDIT_RESET' } }), 1);
  });

  it('keeps a corrected quantity through a re-import of the same line', async () => {
    await importDay('morning');
    const before = await order('2608-700001');
    const soil = before.lines.find(line => line.spruceItemNumber === 'SOILGRDNA')!;

    await applyOrderEdits(before.id, parseEditRequest({ lines: [{ id: soil.id, quantity: '2.5' }] }), userId);
    await importDay('noon');

    const after = await prisma.order.findUniqueOrThrow({ where: { id: soil.id } });
    assert.equal(after.quantity?.toString(), '2.5');
    assert.equal(await prisma.order.count({ where: { documentId: before.id } }), before.lines.length, 'no line duplicated');
  });

  it('moves an order to another day\'s board, lines and all, and keeps it there', async () => {
    await importDay('morning');
    const id = (await order('2608-700001')).id;

    await applyOrderEdits(id, parseEditRequest({ fields: { deliveryDate: '2026-09-03' } }), userId);

    const today = await DispatchService.getDispatchBoard('2026-09-02');
    const tomorrow = await DispatchService.getDispatchBoard('2026-09-03');
    assert.ok(!today.unassignedOrders.some(row => row.id === id));
    const moved = tomorrow.unassignedOrders.find(row => row.id === id);
    assert.equal(moved?.edited, true);
    const lines = await prisma.order.findMany({ where: { documentId: id } });
    assert.ok(lines.every(line => line.deliveryDate?.toISOString().startsWith('2026-09-03')));

    // The 9/2 delivery report still lists it: the dispatcher's day holds, and
    // it is not reported missing from a day it was moved away from.
    await importDay('noon');
    const after = await order('2608-700001');
    assert.equal(after.deliveryDate?.toISOString().slice(0, 10), '2026-09-03');
    assert.ok(!after.flags.includes('NOT_IN_LATEST_REPORT'));
  });

  it("offers a trade account's last delivery address, never a cash sale's", async () => {
    const make = (documentNumber: string, accountCode: string, shippingAddress: string | null, deliveryDate: string) =>
      prisma.orderDocument.create({
        data: { documentNumber, customerName: 'Synthetic', accountCode, shippingAddress, deliveryDate: new Date(deliveryDate) },
      });
    await make('9900-000101', 'TRADE01', 'Old Yard Rd, Cambridge', '2026-08-01');
    await make('9900-000102', 'TRADE01', '12 New Yard Rd, Cambridge', '2026-08-10');
    await make('9900-000103', 'TRADE01', null, '2026-08-14');
    await make('9900-000104', 'CASH', '1 Someone Else St, Kitchener', '2026-08-10');
    await make('9900-000105', 'CASH', null, '2026-08-14');

    const trade = await getOrderForEditing('9900-000103');
    assert.deepEqual(trade.addressSuggestion, { address: '12 New Yard Rd, Cambridge', fromOrder: '9900-000102' });
    // Cash sales share one account and are different people.
    assert.equal((await getOrderForEditing('9900-000105')).addressSuggestion, null);
    // An order that has an address is not offered another.
    assert.equal((await getOrderForEditing('9900-000102')).addressSuggestion, null);
  });

  it('drops the correction when a value is set back to what Spruce says', async () => {
    await importDay('morning');
    const id = (await order('2608-700001')).id;
    await applyOrderEdits(id, parseEditRequest({ fields: { phone: '519-555-0999' } }), userId);
    assert.equal((await order('2608-700001')).overrides.length, 1);

    await applyOrderEdits(id, parseEditRequest({ fields: { phone: '519-555-0128' } }), userId);

    const after = await order('2608-700001');
    assert.equal(after.phone, '519-555-0128');
    assert.equal(after.overrides.length, 0);
  });
});
