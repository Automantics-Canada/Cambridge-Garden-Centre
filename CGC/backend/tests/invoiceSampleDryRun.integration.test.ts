// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import * as extraction from '../src/services/extraction/extraction.service.js';
import { runSampleDryRun } from '../src/scripts/invoiceSampleDryRun.js';
import {
  inReadOnlyTransaction,
  loadRelatedRecordsFromDb,
  loadSuppliers,
} from '../src/scripts/sampleDryRun/loopbackRecords.js';

/**
 * The sample dry run reading its related records from a loopback database
 * (--db): the same rows matchInvoiceLineById would load, inside a transaction
 * PostgreSQL will not let write, and nothing left behind.
 *
 * Every supplier, order, ticket and price here is invented.
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

const USER_ID = '00000000-0000-4000-8000-0000000005a1';
const SUPPLIER_ID = '00000000-0000-4000-8000-0000000005a2';
const PO = '2610-900101';

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "MatchResult", "TicketOrderMatch", "InvoiceLineItem", "Invoice", "Ticket", "Order", ' +
      '"OrderDocument", "NegotiatedRate", "SupplierProductAlias", "Supplier", "User", "SystemSetting" ' +
      'RESTART IDENTITY CASCADE'
  );
}

async function counts(): Promise<number[]> {
  return Promise.all([
    prisma.invoice.count(),
    prisma.invoiceLineItem.count(),
    prisma.matchResult.count(),
    prisma.supplier.count(),
    prisma.ticket.count(),
  ]);
}

describe('sample dry run against a loopback database', { skip: !runnable }, () => {
  let dir: string;

  before(async () => {
    await reset();
    await prisma.user.create({
      data: { id: USER_ID, name: 'Desk', email: 'desk@example.invalid', passwordHash: 'not-a-real-hash', role: 'AP_USER' },
    });
    await prisma.supplier.create({
      data: { id: SUPPLIER_ID, name: 'Example Aggregates Ltd.', type: 'SUPPLIER', emailDomains: [] },
    });
    await prisma.orderDocument.create({
      data: { id: '00000000-0000-4000-8000-0000000005b1', documentNumber: '990101', customerName: 'Test Customer', orderDate: new Date('2026-10-21'), flags: [], sourceReports: ['ORDER_REPORT'] },
    });
    await prisma.order.create({
      data: {
        spruceOrderId: '990101-1',
        documentId: '00000000-0000-4000-8000-0000000005b1',
        lineNumber: 1,
        poNumber: PO,
        customerName: 'Test Customer',
        product: 'Test Clear Stone 19mm',
        quantity: 30,
        unit: 'tonne',
        supplierId: SUPPLIER_ID,
        orderDate: new Date('2026-10-21'),
      },
    });
    // A quotation on the same PO: never a candidate.
    await prisma.orderDocument.create({
      data: { id: '00000000-0000-4000-8000-0000000005b2', documentNumber: '990199', customerName: 'Test Customer', orderDate: new Date('2026-10-20'), flags: ['QUOTE'], sourceReports: ['ITEM_TRACKING'] },
    });
    await prisma.order.create({
      data: {
        spruceOrderId: '990199-1',
        documentId: '00000000-0000-4000-8000-0000000005b2',
        lineNumber: 1,
        poNumber: PO,
        customerName: 'Test Customer',
        product: 'Test Clear Stone 19mm',
        quantity: 30,
        unit: 'tonne',
        supplierId: SUPPLIER_ID,
        orderDate: new Date('2026-10-20'),
      },
    });
    for (const [number, quantity] of [['EX-70011', 15.1], ['EX-70012', 14.9]] as const) {
      await prisma.ticket.create({
        data: {
          source: 'MANUAL',
          supplierId: SUPPLIER_ID,
          ticketNumber: number,
          poNumber: PO,
          material: 'Test Clear Stone 19mm',
          quantity,
          unit: 't',
          ticketDate: new Date('2026-10-21'),
          imageUrl: '/uploads/none.png',
          ocrRawText: '',
          ocrConfidence: 0.95,
          status: 'UNLINKED',
        },
      });
    }
    await prisma.negotiatedRate.create({
      data: { supplierId: SUPPLIER_ID, productName: 'Test Clear Stone 19mm', rate: 31.5, unit: 'tonne', effectiveFrom: new Date('2026-01-01'), createdById: USER_ID },
    });

    dir = mkdtempSync(path.join(tmpdir(), 'cgc-samples-db-'));
    writeFileSync(path.join(dir, 'example.csv'), 'Item,Qty,Unit,Price,Total\nTest Clear Stone 19mm,30,t,31.50,945.00\n');
    writeFileSync(
      path.join(dir, 'example.csv.extraction.json'),
      JSON.stringify({
        invoice: {
          supplierName: 'Example Aggregates Ltd.',
          invoiceNumber: 'INV-55001',
          date: '2026-10-22',
          poNumber: PO,
          totalAmount: 1067.85,
          lineItems: [{ description: 'Test Clear Stone 19mm', quantity: 30, unit: 't', unitPrice: 31.5, totalPrice: 945, poNumber: null }],
          readability: 'clear',
          uncertainFields: [],
        },
      })
    );
  });

  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await reset();
    await prisma.$disconnect();
  });

  it('matches a sample against the database rows and writes nothing', async () => {
    const before = await counts();
    const report = await runSampleDryRun(
      { dir, mode: 'fixture', saveExtractions: false, related: { kind: 'db' }, only: [], writeReport: false },
      {
        extraction,
        db: {
          loadSuppliers: () => inReadOnlyTransaction(prisma, (tx) => loadSuppliers(tx)),
          loadRecords: (suppliers, request) =>
            inReadOnlyTransaction(prisma, (tx) => loadRelatedRecordsFromDb(tx, suppliers, request)),
        },
      }
    );

    const sample = report.samples[0]!;
    assert.equal(report.relatedRecords, 'loopback database');
    assert.equal(sample.supplier?.resolution, 'exact');
    assert.equal(sample.matching?.lines[0]?.status, 'MATCHED');
    assert.equal(sample.matching?.lines[0]?.flag, 'OK');
    assert.equal(sample.matching?.lines[0]?.order?.orderNumber, '990101');
    assert.equal(sample.matching?.lines[0]?.tickets.length, 2);
    assert.equal(sample.matching?.invoiceTotalCheck.result, 'ok');
    assert.deepEqual(await counts(), before);
  });

  it('runs its reads in a transaction PostgreSQL refuses to write in', async () => {
    await assert.rejects(
      inReadOnlyTransaction(prisma, async (tx) =>
        (tx as unknown as typeof prisma).supplier.create({ data: { name: 'Should Not Exist', type: 'SUPPLIER', emailDomains: [] } })
      ),
      /read-only transaction/
    );
    assert.equal(await prisma.supplier.count({ where: { name: 'Should Not Exist' } }), 0);
  });
});
