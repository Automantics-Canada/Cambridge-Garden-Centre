import './setupEnv.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { linkTicketCopies } from '../src/modules/tickets/ticketCopies.js';
import { TicketService } from '../src/modules/tickets/ticket.service.js';
import { matchInvoiceLineById } from '../src/modules/matching/matching.service.js';
import { resolveMatchResult } from '../src/modules/matching/resolveMatch.js';

/**
 * The driver's photo and the supplier's emailed copy of one ticket (A15),
 * against a real database: linked whichever arrives first, counted once by
 * matching, and claimed together when a line is paid.
 *
 * Loopback, disposable database only (scripts/run-tests.mjs). Every name and
 * number is invented.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();

const SUPPLIER_ID = '11111111-1111-4111-8111-1111111111aa';
const OTHER_SUPPLIER_ID = '11111111-1111-4111-8111-1111111111bb';
const USER_ID = '55555555-5555-4555-8555-5555555555aa';
const DAY = new Date('2026-08-13');

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TicketClaim", "MatchResult", "InvoiceSupportingFile", "InvoiceLineItem", "Invoice", "Ticket", "Order", ' +
      '"NegotiatedRate", "SupplierProductAlias", "Supplier", "AuditLog", "User", "SystemSetting" RESTART IDENTITY CASCADE'
  );
  await prisma.user.create({
    data: { id: USER_ID, name: 'Desk', email: 'desk@example.invalid', passwordHash: 'not-a-real-hash', role: 'AP_USER' },
  });
  await prisma.supplier.create({ data: { id: SUPPLIER_ID, name: 'Example Stone Ltd.', type: 'SUPPLIER', emailDomains: [] } });
  await prisma.supplier.create({ data: { id: OTHER_SUPPLIER_ID, name: 'Other Pit Inc.', type: 'SUPPLIER', emailDomains: [] } });
  await prisma.order.create({
    data: {
      spruceOrderId: 'DOC-A15-1',
      poNumber: '482913',
      customerName: 'A Customer',
      product: 'A Gravel 19mm',
      quantity: 24.6,
      unit: 'tonnes',
      supplierId: SUPPLIER_ID,
      orderDate: DAY,
    },
  });
  await prisma.negotiatedRate.create({
    data: {
      supplierId: SUPPLIER_ID, productName: 'A Gravel 19mm', rate: 18, unit: 'tonnes',
      effectiveFrom: new Date('2026-01-01'), createdById: USER_ID,
    },
  });
}

async function ticket(source: 'MANUAL' | 'EMAIL', overrides: Record<string, unknown> = {}) {
  return prisma.ticket.create({
    data: {
      source,
      supplierId: SUPPLIER_ID,
      ticketNumber: 'T-501',
      poNumber: '482913',
      material: 'A Gravel 19mm',
      quantity: 24.6,
      unit: 'tonnes',
      ticketDate: DAY,
      imageUrl: '/uploads/none.png',
      ocrRawText: '',
      ocrConfidence: 0.95,
      status: 'UNLINKED',
      ...overrides,
    },
  });
}

let invoiceCount = 0;
async function invoiceLine(quantity = 24.6): Promise<string> {
  invoiceCount += 1;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-A15-${invoiceCount}`,
      senderType: 'SUPPLIER',
      supplierId: SUPPLIER_ID,
      invoiceDate: new Date('2026-08-14'),
      totalAmount: quantity * 18,
      currency: 'CAD',
      fileUrl: '/uploads/none.pdf',
      emailFrom: 'billing@stone.example',
      emailSubject: 'Invoice',
      gmailMessageId: `a15-${invoiceCount}`,
      ocrRawText: '',
      lineItems: {
        create: {
          lineNumber: 1, description: 'A Gravel 19mm', poNumber: '482913',
          quantity, unit: 'tonnes', unitRate: 18, lineTotal: quantity * 18, flag: 'OK',
        },
      },
    },
    include: { lineItems: true },
  });
  return invoice.lineItems[0]!.id;
}

const check = (decision: { checks: Array<{ name: string; passed: boolean; found?: unknown }> } | null, name: string) =>
  decision?.checks.find((entry) => entry.name === name);

describe('two copies of one ticket', { skip: !(confirmed && loopback) }, () => {
  beforeEach(reset);
  after(async () => {
    await prisma.$disconnect();
  });

  it('the supplier copy arriving after the driver photo is linked to it and the load counts once', async () => {
    const driver = await ticket('MANUAL');
    assert.equal((await linkTicketCopies(driver.id)).primaryId, null, 'alone so far');

    // The supplier prints the number its own way.
    const emailed = await ticket('EMAIL', { ticketNumber: 'T 501' });
    const outcome = await linkTicketCopies(emailed.id);
    assert.equal(outcome.primaryId, driver.id);
    assert.equal(outcome.changed, true);
    assert.deepEqual(outcome.poNumbers, ['482913']);

    const rows = await prisma.ticket.findMany({ select: { id: true, duplicateOfTicketId: true } });
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.id, row.duplicateOfTicketId])),
      { [driver.id]: null, [emailed.id]: driver.id }
    );

    const decision = await matchInvoiceLineById(await invoiceLine());
    assert.equal(check(decision, 'ticketCoverage')?.found, 24.6);
    assert.deepEqual(decision?.ticketIds, [driver.id]);
    assert.equal(check(decision, 'copiesAgree')?.passed, true);
    assert.equal(decision?.status, 'MATCHED');
  });

  it('the driver photo arriving after the supplier copy takes over, and the line stops waiting on AP', async () => {
    const emailed = await ticket('EMAIL');
    await linkTicketCopies(emailed.id);
    const lineId = await invoiceLine();

    const before = await matchInvoiceLineById(lineId);
    assert.equal(check(before, 'billerTicketsOnly')?.passed, false, 'supplier evidence alone');
    assert.equal(before?.status, 'PARTIAL');

    const driver = await ticket('MANUAL', { receivedAt: new Date(Date.now() + 1000) });
    const outcome = await linkTicketCopies(driver.id);
    assert.equal(outcome.primaryId, driver.id, "the driver's copy counts even though it came second");
    assert.equal((await prisma.ticket.findUnique({ where: { id: emailed.id } }))?.duplicateOfTicketId, driver.id);
    assert.equal((await prisma.ticket.findUnique({ where: { id: driver.id } }))?.duplicateOfTicketId, null);

    const afterwards = await matchInvoiceLineById(lineId);
    assert.deepEqual(afterwards?.ticketIds, [driver.id]);
    assert.equal(check(afterwards, 'billerTicketsOnly'), undefined);
    assert.equal(afterwards?.status, 'MATCHED');
  });

  it('a different supplier, a too-short number or a date a year away is not a copy', async () => {
    const driver = await ticket('MANUAL');
    const otherSupplier = await ticket('EMAIL', { supplierId: OTHER_SUPPLIER_ID });
    const lastYear = await ticket('EMAIL', { ticketDate: new Date('2025-08-13') });
    assert.equal((await linkTicketCopies(otherSupplier.id)).primaryId, null);
    assert.equal((await linkTicketCopies(lastYear.id)).primaryId, null);

    const shortA = await ticket('MANUAL', { ticketNumber: '12' });
    const shortB = await ticket('EMAIL', { ticketNumber: '12' });
    assert.equal((await linkTicketCopies(shortB.id)).primaryId, null);
    const linked = await prisma.ticket.count({ where: { duplicateOfTicketId: { not: null } } });
    assert.equal(linked, 0, `${driver.id} ${shortA.id} stay unlinked`);
  });

  it('copies that disagree are flagged, and the driver copy is what is counted', async () => {
    const driver = await ticket('MANUAL');
    const emailed = await ticket('EMAIL', { quantity: 30 });
    await linkTicketCopies(emailed.id);

    const decision = await matchInvoiceLineById(await invoiceLine());
    assert.equal(check(decision, 'copiesAgree')?.passed, false);
    assert.equal(check(decision, 'ticketCoverage')?.found, 24.6);
    assert.deepEqual(decision?.ticketIds, [driver.id]);
    assert.equal(decision?.status, 'PARTIAL');
  });

  it('paying a line claims every copy, so the other copy cannot pay a second invoice', async () => {
    const driver = await ticket('MANUAL');
    const emailed = await ticket('EMAIL');
    await linkTicketCopies(emailed.id);

    const firstLine = await invoiceLine();
    await matchInvoiceLineById(firstLine);
    const verdict = await prisma.matchResult.findUniqueOrThrow({ where: { invoiceLineId: firstLine } });
    const resolved = await resolveMatchResult({ matchResultId: verdict.id, resolution: 'CONFIRMED', userId: USER_ID });
    assert.equal(resolved.ok, true);

    const claims = await prisma.ticketClaim.findMany({ select: { ticketId: true, invoiceLineId: true } });
    assert.deepEqual(claims.map((c) => c.ticketId).sort(), [driver.id, emailed.id].sort());
    assert.ok(claims.every((c) => c.invoiceLineId === firstLine));

    // A repeat invoice for the same load: the emailed copy is spent too.
    const repeat = await matchInvoiceLineById(await invoiceLine());
    assert.equal(check(repeat, 'ticketReuse')?.passed, false);
    assert.deepEqual(repeat?.ticketIds, []);
  });

  it('a claim already made through the supplier copy blocks paying through the driver copy', async () => {
    const emailed = await ticket('EMAIL');
    await linkTicketCopies(emailed.id);
    const firstLine = await invoiceLine();
    await matchInvoiceLineById(firstLine);
    const verdict = await prisma.matchResult.findUniqueOrThrow({ where: { invoiceLineId: firstLine } });
    // Supplier-only evidence: confirmed by a person after checking with the yard.
    assert.equal((await resolveMatchResult({ matchResultId: verdict.id, resolution: 'CONFIRMED', userId: USER_ID })).ok, true);

    const driver = await ticket('MANUAL', { receivedAt: new Date(Date.now() + 1000) });
    await linkTicketCopies(driver.id);
    const repeat = await matchInvoiceLineById(await invoiceLine());
    assert.equal(check(repeat, 'ticketReuse')?.passed, false);
    assert.deepEqual(repeat?.ticketIds, []);
  });

  it('correcting a ticket number through the ticket form unlinks it; the form cannot set the link itself', async () => {
    const driver = await ticket('MANUAL');
    const emailed = await ticket('EMAIL');
    await linkTicketCopies(emailed.id);

    await TicketService.updateTicket(emailed.id, { ticketNumber: 'T-999' });
    assert.equal((await prisma.ticket.findUnique({ where: { id: emailed.id } }))?.duplicateOfTicketId, null);

    await TicketService.updateTicket(emailed.id, { duplicateOfTicketId: driver.id, material: 'A Gravel 19mm' });
    assert.equal((await prisma.ticket.findUnique({ where: { id: emailed.id } }))?.duplicateOfTicketId, null);
  });
});
