// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { prisma } from '../src/db/prisma.js';
import { runImportBatch, type BatchFile } from '../src/modules/orders/import/importBatch.service.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import type { SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
import { deliveryReport, itemTrackingReport, orderSummaryReport } from './fixtures/spruceLayouts.js';

/**
 * scripts/wipe-order-data.mjs against PostgreSQL, run the way a person runs
 * it: as a separate node process with DATABASE_URL in its environment.
 *
 * The database is seeded with a full import of the synthetic reports, a
 * delivery with history, an override, and a ticket and invoice line linked to
 * an order with a resolved verdict and claim — every table the script empties
 * and every link it has to clear.
 */

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ORDER_TABLES = [
  'OrderDocument', 'Order', 'OrderOverride', 'Delivery', 'DeliveryHistory', 'ImportBatch',
  'ImportBatchFile', 'SpruceImportJob', 'SpruceImportRowError', 'TicketOrderMatch', 'MatchResult', 'TicketClaim',
];
const TICKET_INVOICE_TABLES = ['Ticket', 'Invoice', 'InvoiceLineItem', '_InvoiceLineItemToTicket', 'OcrJob'];
const ALWAYS_KEPT = [
  'User', 'Driver', 'Supplier', 'SupplierSpruceVendor', 'SupplierProductAlias', 'NegotiatedRate',
  'SystemSetting', 'Product', 'Unit', 'AuditLog', 'EmailIngestionEvent', 'WhatsAppMessage', '_prisma_migrations',
];

/** The test URL with a password in it, so the test can prove it is never printed. */
const SECRET = 'wipe-test-password-must-not-print';
function scriptUrl(): URL {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!url.password) url.password = SECRET;
  return url;
}

function runScript(args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: scriptUrl().toString(), ...extraEnv };
  if (!('WIPE_CONFIRM_HOST' in extraEnv)) delete env.WIPE_CONFIRM_HOST;
  const result = spawnSync(process.execPath, ['scripts/wipe-order-data.mjs', ...args], {
    cwd: backendRoot,
    env,
    encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;
  return { status: result.status, output };
}

async function tableNames(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`
  );
  return rows.map((row) => row.name);
}

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of await tableNames()) {
    const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "public"."${table}"`);
    result[table] = Number(row!.n);
  }
  return result;
}

async function resetDatabase(): Promise<void> {
  if (!disposableConfirmed) {
    throw new Error('Refusing to clear a database without SPRUCE_TEST_CONFIRM_DISPOSABLE=1');
  }
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "WipeTestProbe"');
  const tables = (await tableNames()).filter((name) => name !== '_prisma_migrations');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

function files(stamp: string): BatchFile[] {
  const reports = {
    ORDER_SUMMARY: parseSprucePages(orderSummaryReport()),
    DELIVERY: parseSprucePages(deliveryReport()),
    ITEM_TRACKING: parseSprucePages(itemTrackingReport()),
  };
  return (Object.keys(reports) as SpruceReportType[]).map((reportType) => ({
    reportType,
    fileName: `${reportType}.pdf`,
    buffer: Buffer.from(`${stamp}-${reportType}`),
    report: reports[reportType],
  }));
}

interface Seeded {
  adminId: string;
  ticketId: string;
  lineId: string;
}

async function seed(): Promise<Seeded> {
  const admin = await prisma.user.create({
    data: { name: 'Wipe Admin', email: 'wipe-admin@example.test', passwordHash: 'x', role: 'ADMIN' },
  });
  const driverUser = await prisma.user.create({
    data: { name: 'Wipe Driver', email: 'wipe-driver@example.test', passwordHash: 'x', role: 'DRIVER' },
  });
  const driver = await prisma.driver.create({
    data: { name: 'Wipe Driver', phone: '519-555-0190', email: 'wipe-driver@example.test', userId: driverUser.id },
  });
  await prisma.driver.create({ data: { name: 'Second Driver', phone: '519-555-0191' } });

  const summary = await runImportBatch(prisma, { dispatchDate: '2026-09-02', createdById: admin.id, files: files('seed') });
  assert.equal(summary.alreadyImported, false);

  const supplier = await prisma.supplier.create({
    data: { name: 'Wipe Supplier', type: 'SUPPLIER', emailDomains: [], keywords: [] },
  });
  await prisma.supplierSpruceVendor.create({ data: { code: 'WIPE-V', supplierId: supplier.id } });
  await prisma.supplierProductAlias.create({ data: { supplierId: supplier.id, aliasText: 'stone', productName: 'Stone' } });
  await prisma.negotiatedRate.create({
    data: {
      supplierId: supplier.id, productName: 'Stone', rate: 10, unit: 'MT', createdById: admin.id,
      effectiveFrom: new Date('2026-01-01'),
    },
  });
  await prisma.systemSetting.create({ data: { key: 'wipe.test', value: true, updatedById: admin.id } });
  await prisma.product.create({ data: { name: 'Wipe Stone' } });
  await prisma.unit.create({ data: { name: 'wipe-unit' } });
  await prisma.whatsAppMessage.create({
    data: { driverId: driver.id, fromPhone: '519-555-0190', messageId: 'wa-1', messageType: 'TEXT', rawPayload: {} },
  });

  const order = await prisma.order.findFirstOrThrow({ where: { document: { documentNumber: '2608-700001' } } });
  const delivery = await prisma.delivery.create({
    data: { orderId: order.id, documentId: order.documentId, driverId: driver.id, status: 'PLACED' },
  });
  await prisma.deliveryHistory.create({ data: { deliveryId: delivery.id, status: 'PLACED' } });
  await prisma.orderOverride.create({
    data: { documentId: order.documentId!, targetKey: 'document', field: 'shippingAddress', value: '1 Test St', editedById: admin.id },
  });
  const job = await prisma.spruceImportJob.create({ data: { uploadedById: admin.id, fileUrl: 'test://legacy.csv' } });
  await prisma.spruceImportRowError.create({
    data: { importJobId: job.id, rowNumber: 1, rawRowData: '', errorMessage: 'synthetic' },
  });

  const ticket = await prisma.ticket.create({
    data: {
      ticketNumber: 'T-WIPE-1', source: 'MANUAL', supplierId: supplier.id, poNumber: '2608-700001',
      imageUrl: 'test://ticket', ocrRawText: '', ocrConfidence: 1,
      status: 'LINKED', linkMethod: 'AUTO', linkedOrderId: order.id, linkedById: admin.id,
    },
  });
  await prisma.ticketOrderMatch.create({ data: { ticketId: ticket.id, orderId: order.id, matchMethod: 'PO_NUMBER' } });
  await prisma.ocrJob.create({ data: { provider: 'OPENAI', type: 'TICKET', ticketId: ticket.id } });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-WIPE-1', senderType: 'SUPPLIER', supplierId: supplier.id, invoiceDate: new Date('2026-09-02'),
      totalAmount: 10, currency: 'CAD', fileUrl: 'test://invoice', emailFrom: 'a@example.test',
      emailSubject: 'Invoice', gmailMessageId: 'gmail-wipe-1',
    },
  });
  const line = await prisma.invoiceLineItem.create({
    data: {
      invoiceId: invoice.id, lineNumber: 1, description: 'Stone', quantity: 1, unit: 'MT', unitRate: 10,
      lineTotal: 10, flag: 'OK', matchedOrderId: order.id, matchedTickets: { connect: [{ id: ticket.id }] },
    },
  });
  const verdict = await prisma.matchResult.create({
    data: {
      subjectType: 'INVOICE_LINE', invoiceLineId: line.id, orderId: order.id, status: 'MATCHED', evidence: [],
      reason: 'synthetic', candidateOrderIds: [], ticketIds: [ticket.id], resolution: 'CONFIRMED',
      resolvedById: admin.id, resolvedAt: new Date(),
    },
  });
  await prisma.ticketClaim.create({
    data: { ticketId: ticket.id, invoiceLineId: line.id, matchResultId: verdict.id, claimedById: admin.id },
  });
  await prisma.emailIngestionEvent.create({
    data: {
      gmailMessageId: 'gmail-wipe-1', subject: 'Invoice', fromAddress: 'a@example.test', toAddress: 'b@example.test',
      createdInvoiceId: invoice.id, createdTicketIds: [],
    },
  });
  await prisma.auditLog.create({
    data: { entityType: 'INVOICE', entityId: invoice.id, actionType: 'SYSTEM_CONFIG_CHANGE', performedById: admin.id },
  });

  return { adminId: admin.id, ticketId: ticket.id, lineId: line.id };
}

describe('wipe-order-data script (PostgreSQL)', { skip: !disposableConfirmed }, () => {
  let seeded: Seeded;

  beforeEach(async () => {
    const host = new URL(process.env.DATABASE_URL ?? '').hostname;
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'only ever against a loopback database');
    await resetDatabase();
    seeded = await seed();
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "WipeTestProbe"');
    await prisma.$disconnect();
  });

  it('seeds every table it is about to empty, so the checks below mean something', async () => {
    const before = await counts();
    for (const table of [...ORDER_TABLES, ...TICKET_INVOICE_TABLES, ...ALWAYS_KEPT]) {
      assert.ok((before[table] ?? 0) > 0, `${table} should hold rows before the wipe`);
    }
  });

  it('dry run prints the host and database, never the password or URL, and changes nothing', async () => {
    const before = await counts();
    const url = scriptUrl();
    const { status, output } = runScript([]);

    assert.equal(status, 0, output);
    assert.match(output, new RegExp(`host=${url.hostname.replace(/[.]/g, '\\.')} `));
    assert.match(output, new RegExp(`database=${decodeURIComponent(url.pathname.slice(1))} `));
    assert.match(output, /DRY RUN/);
    assert.match(output, /Order\s+\d+/);
    assert.ok(!output.includes(decodeURIComponent(url.password)), 'password must not be printed');
    assert.ok(!output.includes(url.toString()), 'the URL must not be printed');
    assert.ok(!output.includes('postgresql://') && !output.includes('postgres://'), 'no connection string at all');
    assert.deepEqual(await counts(), before);
  });

  it('refuses --apply without the confirmation host, or with the wrong one, and changes nothing', async () => {
    const before = await counts();
    const host = scriptUrl().hostname;
    const wrongHost = host === 'localhost' ? '127.0.0.1' : 'localhost';

    const missing = runScript(['--apply']);
    assert.equal(missing.status, 2, missing.output);
    assert.match(missing.output, /Refusing --apply/);

    const wrong = runScript(['--apply'], { WIPE_CONFIRM_HOST: wrongHost });
    assert.equal(wrong.status, 2, wrong.output);
    assert.match(wrong.output, /Refusing --apply/);

    const sloppy = runScript(['--apply'], { WIPE_CONFIRM_HOST: `${host} ` });
    assert.equal(sloppy.status, 2, 'the match is exact');

    assert.deepEqual(await counts(), before);
  });

  it('empties exactly the order tables, unlinks tickets and invoice lines, and keeps everything else', async () => {
    const before = await counts();
    const { status, output } = runScript(['--apply'], { WIPE_CONFIRM_HOST: scriptUrl().hostname });
    assert.equal(status, 0, output);

    const afterCounts = await counts();
    for (const table of ORDER_TABLES) assert.equal(afterCounts[table], 0, `${table} should be empty`);
    if ('OrderChange' in afterCounts) assert.equal(afterCounts.OrderChange, 0);
    else assert.match(output, /OrderChange: skipped, table does not exist/);

    const emptied = new Set([...ORDER_TABLES, 'OrderChange']);
    for (const [table, n] of Object.entries(before)) {
      if (!emptied.has(table)) assert.equal(afterCounts[table], n, `${table} must keep its ${n} rows`);
    }

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: seeded.ticketId } });
    assert.equal(ticket.linkedOrderId, null);
    assert.equal(ticket.linkMethod, null);
    assert.equal(ticket.status, 'UNLINKED');
    assert.equal(ticket.linkedById, seeded.adminId, 'only the order link is cleared');
    const line = await prisma.invoiceLineItem.findUniqueOrThrow({
      where: { id: seeded.lineId },
      include: { matchedTickets: true },
    });
    assert.equal(line.matchedOrderId, null);
    assert.equal(line.matchedTickets.length, 1, 'ticket-to-invoice links are not order data');
    assert.equal(await prisma.user.count(), 2);
    assert.equal(await prisma.driver.count(), 2);
  });

  it('imports again afterwards as if for the first time', async () => {
    const wipe = runScript(['--apply'], { WIPE_CONFIRM_HOST: scriptUrl().hostname });
    assert.equal(wipe.status, 0, wipe.output);

    // The same bytes as the seed: the hash check must not think they were seen.
    const summary = await runImportBatch(prisma, {
      dispatchDate: '2026-09-02',
      createdById: seeded.adminId,
      files: files('seed'),
    });
    assert.equal(summary.alreadyImported, false);
    assert.equal(summary.deliveries, 2);
    assert.ok((await prisma.orderDocument.count()) > 0);
    assert.ok((await prisma.order.count()) > 0);
  });

  it('with --include-tickets-invoices also empties tickets, invoices, their lines and OCR jobs', async () => {
    const before = await counts();
    const { status, output } = runScript(['--apply', '--include-tickets-invoices'], {
      WIPE_CONFIRM_HOST: scriptUrl().hostname,
    });
    assert.equal(status, 0, output);

    const afterCounts = await counts();
    const emptied = new Set([...ORDER_TABLES, ...TICKET_INVOICE_TABLES, 'OrderChange']);
    for (const table of emptied) if (table in afterCounts) assert.equal(afterCounts[table], 0, `${table} should be empty`);
    for (const [table, n] of Object.entries(before)) {
      if (!emptied.has(table)) assert.equal(afterCounts[table], n, `${table} must keep its ${n} rows`);
    }
    const event = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: 'gmail-wipe-1' } });
    assert.equal(event.createdInvoiceId, null, 'the mailbox log stays, its invoice link goes');
  });

  it('refuses, dry or not, when an unknown table holds a foreign key into an emptied table', async () => {
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "WipeTestProbe" (id uuid PRIMARY KEY, "orderId" uuid NOT NULL REFERENCES "Order"(id) ON DELETE CASCADE)'
    );
    await prisma.$executeRawUnsafe(
      'INSERT INTO "WipeTestProbe" SELECT gen_random_uuid(), id FROM "Order" LIMIT 1'
    );
    try {
      const before = await counts();
      const dry = runScript([]);
      assert.equal(dry.status, 2, dry.output);
      assert.match(dry.output, /WipeTestProbe\(orderId\) -> Order/);

      const apply = runScript(['--apply'], { WIPE_CONFIRM_HOST: scriptUrl().hostname });
      assert.equal(apply.status, 2, apply.output);
      assert.deepEqual(await counts(), before, 'a cascade from a kept table must never run');
    } finally {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "WipeTestProbe"');
    }
  });

  it('empties OrderChange too once that table exists', async () => {
    if ((await tableNames()).includes('OrderChange')) {
      // The real table, from the migration: covered by the apply test above.
      return;
    }
    // A stand-in with the planned shape: cascades from OrderDocument, nulls from Order.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "OrderChange" (
         id uuid PRIMARY KEY,
         "documentId" uuid NOT NULL REFERENCES "OrderDocument"(id) ON DELETE CASCADE,
         "lineId" uuid REFERENCES "Order"(id) ON DELETE SET NULL,
         field text NOT NULL)`
    );
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "OrderChange" SELECT gen_random_uuid(), "documentId", id, 'quantity' FROM "Order" WHERE "documentId" IS NOT NULL LIMIT 2`
      );
      const dry = runScript([]);
      assert.equal(dry.status, 0, dry.output);
      assert.match(dry.output, /OrderChange\s+2/);

      const apply = runScript(['--apply'], { WIPE_CONFIRM_HOST: scriptUrl().hostname });
      assert.equal(apply.status, 0, apply.output);
      const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "OrderChange"');
      assert.equal(Number(row!.n), 0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "OrderChange"');
    }
  });
});
