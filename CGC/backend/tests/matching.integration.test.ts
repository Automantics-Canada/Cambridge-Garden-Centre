import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import {
  ENGINE_VERSION,
  matchInvoiceById,
  matchTicketById,
  recomputeInvoiceLinesForSupplier,
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

/**
 * Quotations and rates found by Spruce item code, against a real database.
 *
 * A quotation's lines carry the same supplier, product and dates as a real
 * order. What only the database can show is that the queries leave them out
 * (by PO and by supplier and date), that the automatic ticket link never
 * points at one, and that an agreed rate stored with a Spruce item code is
 * found for an invoice that words the product its own way.
 */
describe('quotations and item-code rates (PostgreSQL)', { skip: !runnable }, () => {
  const QUOTE_DOC_ID = '66666666-6666-4666-8666-666666666661';
  const REAL_DOC_ID = '66666666-6666-4666-8666-666666666662';
  const CLOSED_DOC_ID = '66666666-6666-4666-8666-666666666663';
  const REAL_LINE_ID = '77777777-7777-4777-8777-777777777771';
  const QUOTE_LINE_ID = '77777777-7777-4777-8777-777777777772';
  const CLOSED_LINE_ID = '77777777-7777-4777-8777-777777777773';
  const SOIL_LINE_ID = '77777777-7777-4777-8777-777777777774';
  const TICKET_A = '88888888-8888-4888-8888-888888888881';
  const TICKET_B = '88888888-8888-4888-8888-888888888882';
  const INVOICE_A = '99999999-9999-4999-8999-999999999991';
  const INVOICE_B = '99999999-9999-4999-8999-999999999992';

  async function resetAll(): Promise<void> {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "MatchResult", "TicketOrderMatch", "InvoiceLineItem", "Invoice", "Ticket", ' +
        '"Order", "OrderDocument", "NegotiatedRate", "SupplierProductAlias", "Supplier", "User", ' +
        '"SystemSetting" RESTART IDENTITY CASCADE'
    );
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
  }

  async function documentWithLine(input: {
    documentId: string;
    documentNumber: string;
    flags: string[];
    lineId: string;
    poNumber: string | null;
    product?: string;
    spruceItemNumber?: string;
  }): Promise<void> {
    await prisma.orderDocument.create({
      data: {
        id: input.documentId,
        documentNumber: input.documentNumber,
        customerName: 'Test Customer',
        orderDate: new Date('2026-08-13'),
        flags: input.flags,
        sourceReports: ['ITEM_TRACKING'],
      },
    });
    await prisma.order.create({
      data: {
        id: input.lineId,
        spruceOrderId: `${input.documentNumber}-1`,
        documentId: input.documentId,
        lineNumber: 1,
        spruceItemNumber: input.spruceItemNumber ?? 'AGG19A',
        poNumber: input.poNumber,
        customerName: 'Test Customer',
        product: input.product ?? 'A Gravel 19mm',
        quantity: 24.6,
        unit: 'tonnes',
        supplierId: SUPPLIER_ID,
        orderDate: new Date('2026-08-13'),
      },
    });
  }

  async function ticketFor(id: string, poNumber: string | null): Promise<void> {
    await prisma.ticket.create({
      data: {
        id,
        source: 'MANUAL',
        supplierId: SUPPLIER_ID,
        poNumber,
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

  async function invoiceFor(id: string, line: { poNumber: string | null; description: string; unitRate: number }) {
    await prisma.invoice.create({
      data: {
        id,
        invoiceNumber: `INV-${id.slice(-4)}`,
        senderType: 'SUPPLIER',
        supplierId: SUPPLIER_ID,
        invoiceDate: new Date('2026-08-14'),
        totalAmount: 24.6 * line.unitRate,
        currency: 'CAD',
        fileUrl: '/uploads/none.pdf',
        emailFrom: 'ap@millbrook.example',
        emailSubject: 'Invoice',
        gmailMessageId: `integration-${id}`,
        ocrRawText: '',
        lineItems: {
          create: {
            lineNumber: 1,
            description: line.description,
            poNumber: line.poNumber,
            quantity: 24.6,
            unit: 'tonnes',
            unitRate: line.unitRate,
            lineTotal: 24.6 * line.unitRate,
            flag: 'OK',
          },
        },
      },
    });
  }

  before(async () => {
    await resetAll();
  });

  after(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it('a quotation on the same PO is not a second candidate', async () => {
    await resetAll();
    await documentWithLine({ documentId: REAL_DOC_ID, documentNumber: '9901-100001', flags: [], lineId: REAL_LINE_ID, poNumber: '482913' });
    await documentWithLine({ documentId: QUOTE_DOC_ID, documentNumber: '9901-100002', flags: ['QUOTE'], lineId: QUOTE_LINE_ID, poNumber: '482913' });
    await ticketFor(TICKET_A, '482913');

    // Without the exclusion both lines fit the PO and the quantity equally,
    // which is a CONFLICT over a load that plainly belongs to the real order.
    const decision = await matchTicketById(TICKET_A);
    assert.equal(decision?.status, 'MATCHED');
    assert.equal(decision?.orderId, REAL_LINE_ID);
    assert.deepEqual(decision?.candidateOrderIds, []);
  });

  it('a quotation is not found by supplier, product and date either', async () => {
    await resetAll();
    await documentWithLine({ documentId: REAL_DOC_ID, documentNumber: '9901-100001', flags: [], lineId: REAL_LINE_ID, poNumber: null });
    await documentWithLine({ documentId: QUOTE_DOC_ID, documentNumber: '9901-100002', flags: ['QUOTE'], lineId: QUOTE_LINE_ID, poNumber: null });
    await invoiceFor(INVOICE_A, { poNumber: null, description: 'A Gravel 19mm', unitRate: 18 });

    const [decision] = await matchInvoiceById(INVOICE_A);
    assert.notEqual(decision?.status, 'CONFLICT');
    assert.equal(decision?.orderId, REAL_LINE_ID);
  });

  it('an order line with no document (legacy import) stays a candidate while a quotation exists', async () => {
    // The filter is a NOT over a nullable relation. Written as a subquery it
    // would be NULL for a line with no document, and SQL would drop the line
    // the moment any quotation existed; this pins that it does not.
    await resetAll();
    await documentWithLine({ documentId: QUOTE_DOC_ID, documentNumber: '9901-100002', flags: ['QUOTE'], lineId: QUOTE_LINE_ID, poNumber: '482913' });
    await prisma.order.create({
      data: {
        id: REAL_LINE_ID,
        spruceOrderId: 'LEGACY-1',
        poNumber: '482913',
        customerName: 'Test Customer',
        product: 'A Gravel 19mm',
        quantity: 24.6,
        unit: 'tonnes',
        supplierId: SUPPLIER_ID,
        orderDate: new Date('2026-08-13'),
      },
    });
    await ticketFor(TICKET_A, '482913');

    const decision = await matchTicketById(TICKET_A);
    assert.equal(decision?.status, 'MATCHED');
    assert.equal(decision?.orderId, REAL_LINE_ID);
    const ticket = await prisma.ticket.findUnique({ where: { id: TICKET_A } });
    assert.equal(ticket?.linkedOrderId, REAL_LINE_ID);
  });

  it('an order closed in Spruce (NOT_OPEN) is still matched: its invoice comes after', async () => {
    await resetAll();
    await documentWithLine({ documentId: CLOSED_DOC_ID, documentNumber: '9901-100003', flags: ['NOT_OPEN'], lineId: CLOSED_LINE_ID, poNumber: '482913' });
    await ticketFor(TICKET_A, '482913');

    const decision = await matchTicketById(TICKET_A);
    assert.equal(decision?.orderId, CLOSED_LINE_ID);
  });

  it('a ticket is never linked automatically to a quotation', async () => {
    await resetAll();
    await documentWithLine({ documentId: QUOTE_DOC_ID, documentNumber: '9901-100002', flags: ['QUOTE'], lineId: QUOTE_LINE_ID, poNumber: '482913' });
    await ticketFor(TICKET_A, '482913');

    const decision = await matchTicketById(TICKET_A);
    assert.equal(decision?.status, 'UNMATCHED');
    const ticket = await prisma.ticket.findUnique({ where: { id: TICKET_A } });
    assert.equal(ticket?.linkedOrderId, null);
    assert.equal(ticket?.status, 'UNLINKED');
    assert.equal(await prisma.ticketOrderMatch.count({ where: { ticketId: TICKET_A } }), 0);
  });

  it('an automatic link made before the document was recognised as a quotation is taken away', async () => {
    await resetAll();
    await documentWithLine({ documentId: QUOTE_DOC_ID, documentNumber: '9901-100002', flags: [], lineId: QUOTE_LINE_ID, poNumber: '482913' });
    await ticketFor(TICKET_B, '482913');

    await matchTicketById(TICKET_B);
    const linked = await prisma.ticket.findUnique({ where: { id: TICKET_B } });
    assert.equal(linked?.linkedOrderId, QUOTE_LINE_ID);
    assert.equal(linked?.linkMethod, 'AUTO');

    // A later upload recognises the document as a quotation.
    await prisma.orderDocument.update({ where: { id: QUOTE_DOC_ID }, data: { flags: ['QUOTE'] } });
    await matchTicketById(TICKET_B);

    const after = await prisma.ticket.findUnique({ where: { id: TICKET_B } });
    assert.equal(after?.linkedOrderId, null);
    assert.equal(after?.status, 'UNLINKED');
    assert.equal(await prisma.ticketOrderMatch.count({ where: { ticketId: TICKET_B } }), 0);
  });

  it('a person linking a ticket to a quotation is left alone', async () => {
    await resetAll();
    await documentWithLine({ documentId: QUOTE_DOC_ID, documentNumber: '9901-100002', flags: ['QUOTE'], lineId: QUOTE_LINE_ID, poNumber: '482913' });
    await ticketFor(TICKET_A, '482913');
    await prisma.ticket.update({
      where: { id: TICKET_A },
      data: { linkedOrderId: QUOTE_LINE_ID, status: 'LINKED', linkMethod: 'MANUAL' },
    });

    await matchTicketById(TICKET_A);
    const ticket = await prisma.ticket.findUnique({ where: { id: TICKET_A } });
    assert.equal(ticket?.linkedOrderId, QUOTE_LINE_ID);
    assert.equal(ticket?.linkMethod, 'MANUAL');
  });

  it('finds the agreed rate by Spruce item code, stores it on the line, and says how', async () => {
    await resetAll();
    await documentWithLine({
      documentId: REAL_DOC_ID,
      documentNumber: '9901-100004',
      flags: [],
      lineId: SOIL_LINE_ID,
      poNumber: '482914',
      product: 'SOIL GARDEN MIX',
      spruceItemNumber: 'SOILGRDNA',
    });
    // The supplier calls it something else again.
    await invoiceFor(INVOICE_B, { poNumber: '482914', description: 'Triple Mix Bulk', unitRate: 21.4 });

    // No rate yet: the line says so.
    const [before] = await matchInvoiceById(INVOICE_B);
    assert.match(before?.checks.find((check) => check.name === 'rate')?.detail ?? '', /No agreed rate/);

    // The price list arrives with the Spruce code. The re-check that runs
    // after a rate change goes through the same engine.
    await prisma.negotiatedRate.create({
      data: {
        supplierId: SUPPLIER_ID,
        productName: 'Garden Soil',
        rate: 18,
        unit: 'tonnes',
        spruceItemCode: 'SOILGRDNA',
        effectiveFrom: new Date('2026-01-01'),
        createdById: USER_ID,
      },
    });
    const pass = await recomputeInvoiceLinesForSupplier(SUPPLIER_ID);
    assert.equal(pass.lines, 1);

    const line = await prisma.invoiceLineItem.findFirst({
      where: { invoiceId: INVOICE_B },
      include: { matchResult: true },
    });
    assert.equal(Number(line?.negotiatedRate), 18);
    assert.equal(Number(line?.rateDiscrepancy), 3.4);
    assert.equal(line?.matchedOrderId, SOIL_LINE_ID);
    assert.equal(line?.matchResult?.engineVersion, ENGINE_VERSION);
    const evidence = line?.matchResult?.evidence as Array<{ name: string; detail: string }>;
    const rate = evidence.find((check) => check.name === 'rate');
    assert.match(rate?.detail ?? '', /found by item code SOILGRDNA/);
    assert.match(rate?.detail ?? '', /18\.9%/);
  });

  it('a rate that ended before the invoice date is not found by item code either', async () => {
    await prisma.negotiatedRate.updateMany({
      where: { supplierId: SUPPLIER_ID, spruceItemCode: 'SOILGRDNA' },
      data: { effectiveTo: new Date('2026-08-01') },
    });
    await matchInvoiceById(INVOICE_B);
    const line = await prisma.invoiceLineItem.findFirst({ where: { invoiceId: INVOICE_B } });
    assert.equal(line?.negotiatedRate, null);
  });
});
