import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import {
  matchInvoiceById,
  matchTicketById,
} from '../src/modules/matching/matching.service.js';

/**
 * The matching path against a real database.
 *
 * matchEngine.test.ts covers the decisions themselves. What can only be checked
 * here is the wiring: that the right rows are loaded, that a verdict is stored
 * with its evidence, and — the rule that protects a person's afternoon — that
 * recomputing does not overwrite a verdict someone has already resolved.
 *
 * Needs a disposable database. Skips entirely without one, so `npm test` on a
 * laptop with no Postgres still passes:
 *
 *   CGC_TEST_CONFIRM_DISPOSABLE=1 \
 *   DATABASE_URL=postgresql://dev:dev@localhost:55433/cgc \
 *     npx tsx --test tests/matching.integration.test.ts
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
})();

const runnable = confirmed && loopback;

const SUPPLIER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const TICKET_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "MatchResult", "InvoiceLineItem", "Invoice", "Ticket", "Order", ' +
      '"NegotiatedRate", "SupplierProductAlias", "Supplier", "User", "SystemSetting" ' +
      'RESTART IDENTITY CASCADE'
  );
}

/** One order for 24.6 tonnes of A Gravel on PO 482913, and a ticket for it. */
async function seed(): Promise<void> {
  await reset();

  await prisma.user.create({
    data: {
      id: USER_ID,
      name: 'Desk',
      email: 'desk@example.invalid',
      passwordHash: 'not-a-real-hash',
      role: 'AP_USER',
    },
  });

  await prisma.supplier.create({
    data: { id: SUPPLIER_ID, name: 'Millbrook Aggregates Ltd.', type: 'SUPPLIER', emailDomains: [] },
  });

  await prisma.order.create({
    data: {
      id: ORDER_ID,
      spruceOrderId: 'DOC-1-1',
      poNumber: '482913',
      customerName: 'A Customer',
      product: 'A Gravel 19mm',
      quantity: 24.6,
      unit: 'tonnes',
      supplierId: SUPPLIER_ID,
      orderDate: new Date('2026-08-13'),
    },
  });

  await prisma.ticket.create({
    data: {
      id: TICKET_ID,
      source: 'MANUAL',
      supplierId: SUPPLIER_ID,
      poNumber: '482913',
      material: 'A Gravel 19mm',
      quantity: 24.6,
      unit: 'tonnes',
      ticketDate: new Date('2026-08-13'),
      imageUrl: '/uploads/none.png',
      ocrRawText: '',
      ocrConfidence: 0.95,
      status: 'UNLINKED',
    },
  });
}

describe('matching against a database', { skip: !runnable }, () => {
  before(async () => {
    await seed();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('stores a MATCHED verdict for a ticket backed by its order', async () => {
    const decision = await matchTicketById(TICKET_ID);
    assert.equal(decision?.status, 'MATCHED');
    assert.equal(decision?.orderId, ORDER_ID);

    const stored = await prisma.matchResult.findFirst({ where: { ticketId: TICKET_ID } });
    assert.equal(stored?.status, 'MATCHED');
    assert.equal(stored?.orderId, ORDER_ID);

    // The evidence is the product; a status without it is what this replaced.
    const evidence = stored?.evidence as Array<{ name: string; passed: boolean }>;
    assert.ok(Array.isArray(evidence) && evidence.length > 0);
    assert.ok(evidence.every((check) => typeof check.passed === 'boolean'));
  });

  it('recomputing replaces an unresolved verdict rather than duplicating it', async () => {
    await matchTicketById(TICKET_ID);
    const count = await prisma.matchResult.count({ where: { ticketId: TICKET_ID } });
    assert.equal(count, 1);
  });

  it('never overwrites a verdict a person has resolved', async () => {
    // Someone looked at this ticket and decided. Re-importing a Spruce report
    // must not quietly undo that.
    await prisma.matchResult.updateMany({
      where: { ticketId: TICKET_ID },
      data: {
        resolution: 'CONFIRMED',
        resolvedById: USER_ID,
        resolvedAt: new Date(),
        status: 'MATCHED',
      },
    });

    // Change the world so a recompute would now reach a different answer.
    await prisma.order.update({ where: { id: ORDER_ID }, data: { quantity: 90 } });

    await matchTicketById(TICKET_ID);

    const stored = await prisma.matchResult.findFirst({ where: { ticketId: TICKET_ID } });
    assert.equal(stored?.status, 'MATCHED', 'a resolved verdict was overwritten');
    assert.equal(stored?.resolution, 'CONFIRMED');

    await prisma.order.update({ where: { id: ORDER_ID }, data: { quantity: 24.6 } });
  });

  it('catches an invoice billed above the agreed rate', async () => {
    await prisma.negotiatedRate.create({
      data: {
        supplierId: SUPPLIER_ID,
        productName: 'A Gravel 19mm',
        rate: 18,
        unit: 'tonnes',
        effectiveFrom: new Date('2026-01-01'),
        createdById: USER_ID,
      },
    });

    await prisma.invoice.create({
      data: {
        id: INVOICE_ID,
        invoiceNumber: 'INV-9001',
        senderType: 'SUPPLIER',
        supplierId: SUPPLIER_ID,
        invoiceDate: new Date('2026-08-14'),
        totalAmount: 526.44,
        currency: 'CAD',
        fileUrl: '/uploads/none.pdf',
        emailFrom: 'ap@millbrook.example',
        emailSubject: 'INV-9001',
        gmailMessageId: 'integration-9001',
        ocrRawText: '',
        lineItems: {
          create: {
            lineNumber: 1,
            description: 'A Gravel 19mm',
            poNumber: '482913',
            quantity: 24.6,
            unit: 'tonnes',
            // Agreed 18.00; billed 21.40 — 18.9% over.
            unitRate: 21.4,
            lineTotal: 526.44,
            flag: 'OK',
          },
        },
      },
    });

    const decisions = await matchInvoiceById(INVOICE_ID);
    assert.equal(decisions.length, 1);

    const decision = decisions[0];
    assert.equal(decision?.status, 'PARTIAL');

    const rate = decision?.checks.find((check) => check.name === 'rate');
    assert.equal(rate?.passed, false);
    assert.match(rate?.detail ?? '', /18\.9%/);

    // The ticket covers the quantity, so that check should pass and the only
    // complaint should be the price.
    const coverage = decision?.checks.find((check) => check.name === 'ticketCoverage');
    assert.equal(coverage?.passed, true);
  });
});
