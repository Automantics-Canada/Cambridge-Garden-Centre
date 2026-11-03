// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import jwt from 'jsonwebtoken';

import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import {
  matchInvoiceById,
  matchInvoiceLineById,
  recomputeInvoiceLinesForSupplier,
} from '../src/modules/matching/matching.service.js';
import { refreshInvoiceTotalCheck } from '../src/modules/invoices/invoice.service.js';
import { waitForRateRechecks } from '../src/modules/supplier/rateRecheck.js';

/**
 * Agreed rates against PostgreSQL, through the HTTP API.
 *
 * Covers what the pure tests cannot: that a new price closes the old period in
 * the database instead of overwriting it, that edits ignore fields the form
 * does not have and clear an end date without an invalid date, that a rate can
 * only be changed under its own supplier, that every change leaves an audit
 * row, that a price list is saved all or nothing, and that open invoice lines
 * are re-checked when rates change while a person's resolved verdict is left
 * alone.
 *
 * Every supplier, product, price and number here is invented.
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

const PRODUCT = 'Test Gravel 19mm';
const PO = '9900-482913';

let server: Server;
let baseUrl: string;
let officeToken: string;
let driverToken: string;
let officeUserId: string;
let supplierId: string;
let otherSupplierId: string;

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "MatchResult", "InvoiceLineItem", "Invoice", "Ticket", "Order", ' +
      '"NegotiatedRate", "SupplierProductAlias", "SupplierSpruceVendor", "Supplier", "User", "SystemSetting" ' +
      'RESTART IDENTITY CASCADE'
  );
}

async function api(method: string, path: string, body?: unknown, token = officeToken) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function upload(path: string, file: Buffer, filename: string, fields: Record<string, string> = {}, token = officeToken) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)]), filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, body: await response.json() };
}

const csv = (lines: string[]) =>
  Buffer.from(['product,spruce_item_code,supplier_item_code,unit,rate,effective_from,effective_to,notes', ...lines].join('\n'));

async function rates(id = supplierId) {
  const rows = await prisma.negotiatedRate.findMany({ where: { supplierId: id }, orderBy: [{ productName: 'asc' }, { effectiveFrom: 'asc' }] });
  return rows.map((r) => ({
    id: r.id,
    productName: r.productName,
    unit: r.unit,
    rate: Number(r.rate),
    from: r.effectiveFrom.toISOString().slice(0, 10),
    to: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
    spruceItemCode: r.spruceItemCode,
    supplierItemCode: r.supplierItemCode,
  }));
}

async function auditActions(entityId?: string) {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'RATE', ...(entityId ? { entityId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => row.actionType);
}

/** An order, its ticket, and an invoice of `quantity` tonnes billed at `unitRate`. */
async function seedInvoice(number: string, invoiceDate: string, unitRate: number, status: 'PENDING_REVIEW' | 'VERIFIED' = 'PENDING_REVIEW') {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: number,
      senderType: 'SUPPLIER',
      supplierId,
      invoiceDate: new Date(`${invoiceDate}T00:00:00.000Z`),
      totalAmount: Number((10 * unitRate * 1.13).toFixed(2)),
      currency: 'CAD',
      fileUrl: '/uploads/none.pdf',
      emailFrom: 'ap@example.invalid',
      emailSubject: number,
      gmailMessageId: `rates-it-${number}`,
      ocrRawText: '',
      status,
      lineItems: {
        create: {
          lineNumber: 1,
          description: PRODUCT,
          poNumber: PO,
          quantity: 10,
          unit: 'tonnes',
          unitRate,
          lineTotal: 10 * unitRate,
          flag: 'OK',
        },
      },
    },
    include: { lineItems: true },
  });
  return { invoiceId: invoice.id, lineId: invoice.lineItems[0]!.id };
}

describe('agreed rates (PostgreSQL)', { skip: !runnable }, () => {
  before(async () => {
    await reset();
    const office = await prisma.user.create({
      data: { name: 'Desk', email: 'desk-rates@example.invalid', passwordHash: 'x', role: 'AP_USER' },
    });
    const driver = await prisma.user.create({
      data: { name: 'Driver', email: 'driver-rates@example.invalid', passwordHash: 'x', role: 'DRIVER' },
    });
    officeUserId = office.id;
    officeToken = jwt.sign({ id: office.id, email: office.email, role: office.role }, env.jwtSecret);
    driverToken = jwt.sign({ id: driver.id, email: driver.email, role: driver.role }, env.jwtSecret);

    const { default: app } = await import('../src/app.js');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await waitForRateRechecks();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditLog", "MatchResult", "InvoiceLineItem", "Invoice", "Ticket", "Order", ' +
        '"NegotiatedRate", "SupplierProductAlias", "Supplier" RESTART IDENTITY CASCADE'
    );
    supplierId = (await prisma.supplier.create({ data: { name: 'Example Aggregates', type: 'SUPPLIER', emailDomains: [] } })).id;
    otherSupplierId = (await prisma.supplier.create({ data: { name: 'Other Example Pit', type: 'SUPPLIER', emailDomains: [] } })).id;
  });

  after(async () => {
    await waitForRateRechecks();
    server?.close();
    await prisma.$disconnect();
  });

  describe('adding one rate', () => {
    it('refuses a bare "ton" and an unknown unit, and saves nothing', async () => {
      const ton = await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'ton', effectiveFrom: '2026-01-01' });
      assert.equal(ton.status, 400);
      assert.match(ton.body.error, /metric tonne or a short ton/);
      const tm = await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'tm', effectiveFrom: '2026-01-01' });
      assert.equal(tm.status, 400);
      assert.deepEqual(await rates(), []);
    });

    it('a later price closes the current one instead of overwriting it, with audit rows', async () => {
      const first = await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: '18.00', unit: 'tonne', effectiveFrom: '2026-01-01' });
      assert.equal(first.status, 201);
      assert.equal(first.body.action, 'CREATE');

      const second = await api('POST', `/api/suppliers/${supplierId}/rates`, {
        productName: PRODUCT, rate: 19.5, unit: 'tonne', effectiveFrom: '2026-11-01', spruceItemCode: 'GRVL19',
      });
      assert.equal(second.status, 201);
      assert.equal(second.body.action, 'SUPERSEDE');
      assert.equal(second.body.supersededRateId, first.body.rate.id);

      const stored = await rates();
      assert.deepEqual(stored.map((r) => [r.rate, r.from, r.to, r.spruceItemCode]), [
        [18, '2026-01-01', '2026-10-31', null],
        [19.5, '2026-11-01', null, 'GRVL19'],
      ]);
      assert.deepEqual(await auditActions(first.body.rate.id), ['RATE_CREATED', 'RATE_EXPIRED']);
      assert.deepEqual(await auditActions(second.body.rate.id), ['RATE_CREATED']);

      // An invoice dated before the new price is still checked against the old one.
      const { lineId } = await seedInvoice('INV-OLD', '2026-10-15', 18);
      await matchInvoiceLineById(lineId);
      const line = await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: lineId } });
      assert.equal(Number(line.negotiatedRate), 18);
    });

    it('keeps a second unit for the same product as its own rate', async () => {
      await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-01-01' });
      const skid = await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 120, unit: 'skid', effectiveFrom: '2026-01-01' });
      assert.equal(skid.body.action, 'CREATE');
      assert.deepEqual((await rates()).map((r) => r.unit).sort(), ['skid', 'tonne']);
    });

    it('re-adding the running price with a newer date and empty boxes keeps its notes and codes', async () => {
      // The Add rate form always sends notes, '' when the box is left empty.
      const first = await api('POST', `/api/suppliers/${supplierId}/rates`, {
        productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-01-01', notes: 'Yard price', spruceItemCode: 'GRVL19',
      });
      assert.equal(first.status, 201);
      const kept = async () =>
        prisma.negotiatedRate.findUniqueOrThrow({ where: { id: first.body.rate.id }, select: { notes: true, spruceItemCode: true, effectiveFrom: true } });

      const again = await api('POST', `/api/suppliers/${supplierId}/rates`, {
        productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-11-01', effectiveTo: '', notes: '',
      });
      assert.equal(again.body.action, 'UNCHANGED', JSON.stringify(again.body));
      assert.deepEqual(await kept(), { notes: 'Yard price', spruceItemCode: 'GRVL19', effectiveFrom: new Date('2026-01-01') });

      // A note that is given is saved; a code sent blank is still not cleared.
      const noted = await api('POST', `/api/suppliers/${supplierId}/rates`, {
        productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-11-01', notes: 'Price held for 2027', spruceItemCode: null,
      });
      assert.equal(noted.body.action, 'CORRECT', JSON.stringify(noted.body));
      assert.deepEqual(await kept(), { notes: 'Price held for 2027', spruceItemCode: 'GRVL19', effectiveFrom: new Date('2026-01-01') });
      assert.equal((await rates()).length, 1);
    });

    it('refuses a start that would overlap a later rate', async () => {
      await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-06-01' });
      const early = await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 17, unit: 'tonne', effectiveFrom: '2026-01-01' });
      assert.equal(early.status, 409);
      assert.match(early.body.error, /A rate starting 2026-06-01 already exists/);
      assert.equal((await rates()).length, 1);
    });
  });

  describe('editing, expiring and deleting', () => {
    async function oneRate(overrides: Record<string, unknown> = {}) {
      const created = await api('POST', `/api/suppliers/${supplierId}/rates`, {
        productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', ...overrides,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body.rate.id as string;
    }

    it("clears an end date sent as '' and ignores fields the form does not have", async () => {
      const rateId = await oneRate();
      const patched = await api('PATCH', `/api/suppliers/${supplierId}/rates/${rateId}`, {
        effectiveTo: '',
        notes: 'Agreed by phone',
        supplierId: otherSupplierId,
        createdById: '00000000-0000-4000-8000-000000000000',
        id: 'something-else',
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(patched.body.effectiveTo, null);

      const row = await prisma.negotiatedRate.findUniqueOrThrow({ where: { id: rateId } });
      assert.equal(row.effectiveTo, null);
      assert.equal(row.supplierId, supplierId);
      assert.equal(row.createdById, officeUserId);
      assert.equal(row.notes, 'Agreed by phone');
      assert.ok(row.updatedAt, 'updatedAt is set on change');
      assert.deepEqual(await auditActions(rateId), ['RATE_CREATED', 'RATE_UPDATED']);
    });

    it('refuses an edit that would overlap another period, and a reversed period', async () => {
      const rateId = await oneRate();
      await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 20, unit: 'tonne', effectiveFrom: '2027-01-01' });
      const overlap = await api('PATCH', `/api/suppliers/${supplierId}/rates/${rateId}`, { effectiveTo: '2027-03-31' });
      assert.equal(overlap.status, 409);
      const reversed = await api('PATCH', `/api/suppliers/${supplierId}/rates/${rateId}`, { effectiveTo: '2025-01-01' });
      assert.equal(reversed.status, 400);
      const bad = await api('PATCH', `/api/suppliers/${supplierId}/rates/${rateId}`, { rate: '-1' });
      assert.equal(bad.status, 400);
    });

    it("answers 404 for another supplier's rate on edit, expire and delete", async () => {
      const rateId = await oneRate();
      const base = `/api/suppliers/${otherSupplierId}/rates/${rateId}`;
      assert.equal((await api('PATCH', base, { rate: 1 })).status, 404);
      assert.equal((await api('POST', `${base}/expire`, {})).status, 404);
      assert.equal((await api('DELETE', base)).status, 404);
      const row = await prisma.negotiatedRate.findUniqueOrThrow({ where: { id: rateId } });
      assert.equal(Number(row.rate), 18);

      // A malformed id is "not found", not a database error.
      assert.equal((await api('PATCH', `/api/suppliers/${supplierId}/rates/not-a-uuid`, { rate: 1 })).status, 404);
      assert.equal((await api('POST', '/api/suppliers/not-a-uuid/rates', { productName: PRODUCT, rate: 1, unit: 'tonne', effectiveFrom: '2026-01-01' })).status, 404);
    });

    it('expires a rate on the given day and keeps it on record', async () => {
      const rateId = await oneRate();
      const expired = await api('POST', `/api/suppliers/${supplierId}/rates/${rateId}/expire`, { effectiveTo: '2026-06-30' });
      assert.equal(expired.status, 200);
      assert.equal(expired.body.effectiveTo, '2026-06-30');
      assert.equal((await rates())[0]!.to, '2026-06-30');
      assert.deepEqual(await auditActions(rateId), ['RATE_CREATED', 'RATE_EXPIRED']);

      const again = await api('POST', `/api/suppliers/${supplierId}/rates/${rateId}/expire`, { effectiveTo: '2026-07-31' });
      assert.equal(again.status, 409);
    });

    it('deletes an unused rate, but refuses one that priced an invoice line', async () => {
      const unused = await oneRate({ productName: 'Test Sand', unit: 'cy', rate: 32 });
      assert.equal((await api('DELETE', `/api/suppliers/${supplierId}/rates/${unused}`)).status, 200);

      const used = await oneRate();
      const { invoiceId } = await seedInvoice('INV-USED', '2026-03-01', 18);
      await matchInvoiceById(invoiceId);

      const list = await api('GET', '/api/suppliers');
      const listed = list.body.find((s: { id: string }) => s.id === supplierId).negotiatedRates;
      assert.equal(listed.find((r: { id: string }) => r.id === used).inUse, true);

      const refused = await api('DELETE', `/api/suppliers/${supplierId}/rates/${used}`);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /Expire it instead/);
      assert.equal((await rates()).length, 1);
    });
  });

  describe('price-list import', () => {
    const good = csv([
      `${PRODUCT},GRVL19,MA-100,tonne,19.50,2026-11-01,,New list`,
      'Test Sand,,MA-200,cy,32,2026-11-01,,',
    ]);

    it('previews without writing anything, from CSV and from .xlsx alike', async () => {
      await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-01-01' });
      const before = { rates: await rates(), audits: await prisma.auditLog.count() };

      const fromCsv = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, good, 'prices.csv');
      assert.equal(fromCsv.status, 200, JSON.stringify(fromCsv.body));
      assert.deepEqual(fromCsv.body.plan.counts, { CREATE: 1, SUPERSEDE: 1, CORRECT: 0, UNCHANGED: 0, ERROR: 0 });
      assert.equal(fromCsv.body.plan.canCommit, true);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Prices');
      ws.addRow(['product', 'spruce_item_code', 'supplier_item_code', 'unit', 'rate', 'effective_from', 'effective_to', 'notes']);
      ws.addRow([PRODUCT, 'GRVL19', 'MA-100', 'tonne', 19.5, new Date(Date.UTC(2026, 10, 1)), null, 'New list']);
      ws.addRow(['Test Sand', null, 'MA-200', 'cy', 32, '2026-11-01']);
      const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
      const fromXlsx = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, xlsx, 'prices.xlsx');
      assert.equal(fromXlsx.status, 200, JSON.stringify(fromXlsx.body));
      assert.equal(fromXlsx.body.file.kind, 'xlsx');
      assert.deepEqual(fromXlsx.body.plan.counts, fromCsv.body.plan.counts);

      assert.deepEqual(await rates(), before.rates);
      assert.equal(await prisma.auditLog.count(), before.audits);
    });

    it('saves every row with audit rows, and closes the old price', async () => {
      await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-01-01' });
      const preview = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, good, 'prices.csv');
      const saved = await upload(`/api/suppliers/${supplierId}/rates/import`, good, 'prices.csv', { token: preview.body.token });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      assert.deepEqual((await rates()).map((r) => [r.productName, r.rate, r.from, r.to, r.spruceItemCode, r.supplierItemCode]), [
        [PRODUCT, 18, '2026-01-01', '2026-10-31', null, null],
        [PRODUCT, 19.5, '2026-11-01', null, 'GRVL19', 'MA-100'],
        ['Test Sand', 32, '2026-11-01', null, null, 'MA-200'],
      ]);
      const imported = await prisma.auditLog.findMany({ where: { entityType: 'RATE' }, orderBy: { createdAt: 'asc' } });
      const fromFile = imported.filter((row) => (row.details as { source?: string }).source === 'price-list');
      assert.deepEqual(fromFile.map((row) => row.actionType).sort(), ['RATE_CREATED', 'RATE_CREATED', 'RATE_EXPIRED']);
    });

    it('saves the item codes of a same-price row with a newer date on the rate already running', async () => {
      await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-01-01' });
      const sameprice = csv([`${PRODUCT},GRVL19,MA-100,tonne,18,2026-11-01,,`]);
      const preview = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, sameprice, 'prices.csv');
      assert.equal(preview.body.plan.rows[0].action, 'CORRECT', JSON.stringify(preview.body.plan.rows[0]));
      assert.equal(preview.body.plan.canCommit, true);

      const saved = await upload(`/api/suppliers/${supplierId}/rates/import`, sameprice, 'prices.csv', { token: preview.body.token });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual((await rates()).map((r) => [r.rate, r.from, r.to, r.spruceItemCode, r.supplierItemCode]), [
        [18, '2026-01-01', null, 'GRVL19', 'MA-100'],
      ]);
    });

    it('saves nothing when one row is wrong', async () => {
      const mixed = csv([`${PRODUCT},,,tonne,19.50,2026-11-01,,`, 'Test Sand,,,cy,thirty,2026-11-01,,']);
      const preview = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, mixed, 'prices.csv');
      assert.equal(preview.body.plan.canCommit, false);
      assert.equal(preview.body.plan.rows[1].action, 'ERROR');

      const saved = await upload(`/api/suppliers/${supplierId}/rates/import`, mixed, 'prices.csv', { token: preview.body.token });
      assert.equal(saved.status, 422);
      assert.deepEqual(await rates(), []);
      assert.equal(await prisma.auditLog.count(), 0);
    });

    it('refuses to save when the rates changed since the preview, and shows the new preview', async () => {
      const preview = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, good, 'prices.csv');
      await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 18, unit: 'tonne', effectiveFrom: '2026-01-01' });

      const saved = await upload(`/api/suppliers/${supplierId}/rates/import`, good, 'prices.csv', { token: preview.body.token });
      assert.equal(saved.status, 409);
      assert.equal(saved.body.preview.plan.counts.SUPERSEDE, 1);
      assert.equal((await rates()).length, 1);
    });

    it('makes the person say which ton a file means', async () => {
      const tons = csv([`${PRODUCT},,,ton,19.50,2026-11-01,,`]);
      const asked = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, tons, 'prices.csv');
      assert.equal(asked.body.plan.needsTonChoice, true);
      assert.equal(asked.body.plan.canCommit, false);

      const told = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, tons, 'prices.csv', { tonMeans: 'SHORT_TON' });
      assert.equal(told.body.plan.canCommit, true);
      const saved = await upload(`/api/suppliers/${supplierId}/rates/import`, tons, 'prices.csv', { token: told.body.token, tonMeans: 'SHORT_TON' });
      assert.equal(saved.status, 200);
      assert.equal((await rates())[0]!.unit, 'short ton');
    });

    it('refuses an old .xls and a file for an unknown supplier', async () => {
      const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
      const legacy = await upload(`/api/suppliers/${supplierId}/rates/import/preview`, xls, 'prices.xls');
      assert.equal(legacy.status, 415);
      assert.match(legacy.body.error, /\.xlsx or CSV UTF-8/);

      const unknown = await upload('/api/suppliers/00000000-0000-4000-8000-000000000000/rates/import/preview', good, 'prices.csv');
      assert.equal(unknown.status, 404);
    });
  });

  describe('re-checking open invoices when rates change', () => {
    it('re-prices unresolved lines and refreshes the total, leaving resolved and verified ones alone', async () => {
      await prisma.order.create({
        data: {
          spruceOrderId: 'DOC-RATES-1', poNumber: PO, customerName: 'A Customer', product: PRODUCT,
          quantity: 30, unit: 'tonnes', supplierId, orderDate: new Date('2026-11-02'),
        },
      });
      for (const n of [1, 2, 3]) {
        await prisma.ticket.create({
          data: {
            source: 'MANUAL', supplierId, poNumber: PO, ticketNumber: `T-${n}`, material: PRODUCT, quantity: 10, unit: 'tonnes',
            ticketDate: new Date('2026-11-02'), imageUrl: '/uploads/none.png', ocrRawText: '', ocrConfidence: 0.95, status: 'UNLINKED',
          },
        });
      }

      const open = await seedInvoice('INV-OPEN', '2026-11-03', 19.5);
      const resolved = await seedInvoice('INV-RESOLVED', '2026-11-03', 19.5);
      const verified = await seedInvoice('INV-VERIFIED', '2026-11-03', 19.5, 'VERIFIED');
      for (const invoice of [open, resolved, verified]) await matchInvoiceById(invoice.invoiceId);
      await refreshInvoiceTotalCheck(open.invoiceId);

      const openBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: open.invoiceId } });
      assert.match(openBefore.disputeNote ?? '', /checked again automatically/);
      assert.doesNotMatch(openBefore.disputeNote ?? '', /reopen/);
      assert.equal((await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: open.lineId } })).negotiatedRate, null);

      // A person ruled on this line before any rate existed. It is theirs.
      const resolvedBefore = await prisma.matchResult.update({
        where: { invoiceLineId: resolved.lineId },
        data: { resolution: 'REJECTED', resolvedById: officeUserId, resolvedAt: new Date(), resolutionNote: 'Checked by hand' },
      });

      const added = await api('POST', `/api/suppliers/${supplierId}/rates`, { productName: PRODUCT, rate: 19.5, unit: 'tonne', effectiveFrom: '2026-11-01' });
      assert.equal(added.status, 201);
      await waitForRateRechecks();

      const openLine = await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: open.lineId }, include: { matchResult: true } });
      assert.equal(Number(openLine.negotiatedRate), 19.5);
      const rateCheck = (openLine.matchResult?.evidence as Array<{ name: string; passed: boolean }>).find((c) => c.name === 'rate');
      assert.equal(rateCheck?.passed, true);
      const openAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: open.invoiceId } });
      assert.equal(openAfter.disputeNote, null, 'billed 10 t x $19.50 + HST matches, so no note');

      const resolvedAfter = await prisma.matchResult.findUniqueOrThrow({ where: { invoiceLineId: resolved.lineId } });
      assert.equal(resolvedAfter.resolution, 'REJECTED');
      assert.equal(resolvedAfter.computedAt.getTime(), resolvedBefore.computedAt.getTime());
      assert.equal((await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: resolved.lineId } })).negotiatedRate, null);

      assert.equal((await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: verified.lineId } })).negotiatedRate, null);
    });

    it('a capped pass starts from the newest invoices, so recent ones are never starved', async () => {
      // Unresolved lines stay unresolved after a pass, so oldest-first would
      // pick the same old lines every time and never reach this week's.
      const old = await seedInvoice('INV-JAN', '2026-01-05', 19.5);
      const recent = await seedInvoice('INV-RECENT', '2026-11-03', 19.5);
      const first = await recomputeInvoiceLinesForSupplier(supplierId, 1);
      assert.equal(first.capped, true);
      assert.deepEqual(first.invoiceIds, [recent.invoiceId]);
      const all = await recomputeInvoiceLinesForSupplier(supplierId, 5);
      assert.equal(all.capped, false);
      assert.deepEqual(all.invoiceIds, [recent.invoiceId, old.invoiceId]);
    });
  });

  describe('drivers', () => {
    it('get 403 from every rate and price-list route', async () => {
      const id = supplierId;
      const checks = [
        await api('POST', `/api/suppliers/${id}/rates`, { productName: PRODUCT, rate: 1, unit: 'tonne', effectiveFrom: '2026-01-01' }, driverToken),
        await api('PATCH', `/api/suppliers/${id}/rates/00000000-0000-4000-8000-000000000000`, { rate: 1 }, driverToken),
        await api('POST', `/api/suppliers/${id}/rates/00000000-0000-4000-8000-000000000000/expire`, {}, driverToken),
        await api('GET', '/api/suppliers', undefined, driverToken),
        await upload(`/api/suppliers/${id}/rates/import/preview`, csv([]), 'prices.csv', {}, driverToken),
        await upload(`/api/suppliers/${id}/rates/import`, csv([]), 'prices.csv', {}, driverToken),
      ];
      assert.deepEqual(checks.map((c) => c.status), [403, 403, 403, 403, 403, 403]);
      assert.deepEqual(await rates(), []);
    });
  });
});
