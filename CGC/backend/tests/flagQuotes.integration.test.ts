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

async function seed(documentNumber: string, data: { sourceReports: string[]; flags?: string[]; line?: Record<string, unknown> }) {
  return prisma.orderDocument.create({
    data: {
      documentNumber,
      customerName: 'Synthetic Customer',
      sourceReports: data.sourceReports,
      flags: data.flags ?? [],
      isPickup: true,
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

const flagsOf = async (documentNumber: string) =>
  prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber }, select: { flags: true, isPickup: true } });

describe('flagging stored quotations (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "OrderDocument", "Order", "Delivery", "Driver" RESTART IDENTITY CASCADE');
    await seed('9900-000001', { sourceReports: ['ITEM_TRACKING'], flags: ['NOT_OPEN'] });
    await seed('9900-000002', { sourceReports: ['ITEM_TRACKING'] });
    await seed('9900-000003', { sourceReports: ['DELIVERY', 'ITEM_TRACKING'] });
    await seed('9900-000004', { sourceReports: ['ITEM_TRACKING'], line: { poNumber: '9900-300004' } });
    await seed('9900-000005', { sourceReports: ['ITEM_TRACKING'], line: { hasInvoice: true } });
    await seed('9900-000006', { sourceReports: ['ITEM_TRACKING'], flags: ['QUOTE'] });
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('plans only Item-Tracking-only documents with no history, and the plan writes nothing', async () => {
    const before = await prisma.orderDocument.findMany({ orderBy: { documentNumber: 'asc' } });
    const plan = await planQuoteFlags(prisma);

    assert.deepEqual(plan.map(item => [item.documentNumber, item.before, item.after]), [
      ['9900-000001', ['NOT_OPEN'], ['QUOTE']],
      ['9900-000002', [], ['QUOTE']],
    ]);
    assert.deepEqual(await prisma.orderDocument.findMany({ orderBy: { documentNumber: 'asc' } }), before);
  });

  it('writes only the allowlist when one is given, and then the rest', async () => {
    const result = await applyQuoteFlags(prisma, await planQuoteFlags(prisma, ['9900-000001']));

    assert.deepEqual(result, { written: 1, skipped: [] });
    assert.deepEqual(await flagsOf('9900-000001'), { flags: ['QUOTE'], isPickup: false });
    assert.deepEqual(await flagsOf('9900-000002'), { flags: [], isPickup: true });

    await applyQuoteFlags(prisma, await planQuoteFlags(prisma));
    assert.deepEqual(await flagsOf('9900-000002'), { flags: ['QUOTE'], isPickup: false });
    assert.deepEqual(await planQuoteFlags(prisma), [], 'a second run finds nothing left');
    for (const untouched of ['9900-000003', '9900-000004', '9900-000005']) {
      assert.ok(!(await flagsOf(untouched)).flags.includes('QUOTE'), untouched);
    }
  });

  it('leaves a document whose flags changed after the plan was made', async () => {
    const plan = await planQuoteFlags(prisma);
    await prisma.orderDocument.update({ where: { documentNumber: '9900-000002' }, data: { flags: ['NOT_IN_LATEST_REPORT'] } });

    const result = await applyQuoteFlags(prisma, plan);

    assert.deepEqual(result, { written: 1, skipped: ['9900-000002'] });
    assert.deepEqual((await flagsOf('9900-000002')).flags, ['NOT_IN_LATEST_REPORT']);
  });
});
