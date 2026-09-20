import './setupEnv.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { InvoiceService } from '../src/modules/invoices/invoice.service.js';

/**
 * Linking loads to an invoice line by hand, against a real database.
 *
 * A supplier bills one line for a day's haulage and sends three scale tickets
 * for it, so the desk links them one after another. That is the ordinary case,
 * and it was broken: the relation was written with Prisma's `set`, which
 * replaces it, so every ticket after the first silently dropped the one before
 * it. The desk showed one linked load and the quantity check ran against a
 * third of what arrived.
 *
 * Only a database proves this. `set` and `connect` are indistinguishable in a
 * mock — the difference is what Postgres ends up holding.
 *
 * Needs a disposable database; skips without one.
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

const USER_ID = '66666666-6666-4666-8666-666666666666';
const SUPPLIER_ID = '66666666-6666-4666-8666-66666666666a';
const TICKET_IDS = [
  '66666666-6666-4666-8666-66666666666b',
  '66666666-6666-4666-8666-66666666666c',
  '66666666-6666-4666-8666-66666666666d',
];

/** One invoice line, three loads delivered against it. */
async function seed(): Promise<string> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TicketClaim", "AuditLog", "MatchResult", "TicketOrderMatch", ' +
      '"InvoiceLineItem", "Invoice", "Ticket", "Order", "NegotiatedRate", ' +
      '"SupplierProductAlias", "Supplier", "User" RESTART IDENTITY CASCADE'
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
    data: { id: SUPPLIER_ID, name: 'Millbrook', type: 'SUPPLIER', emailDomains: [] },
  });

  for (const [index, id] of TICKET_IDS.entries()) {
    await prisma.ticket.create({
      data: {
        id,
        source: 'MANUAL',
        supplierId: SUPPLIER_ID,
        poNumber: '482913',
        ticketNumber: `T-8821${index}`,
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

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-2001',
      senderType: 'SUPPLIER',
      supplierId: SUPPLIER_ID,
      invoiceDate: new Date('2026-08-14'),
      totalAmount: 1328.4,
      currency: 'CAD',
      fileUrl: '/uploads/none.pdf',
      emailFrom: 'ap@millbrook.example',
      emailSubject: 'INV-2001',
      gmailMessageId: 'manual-link-INV-2001',
      ocrRawText: '',
      lineItems: {
        create: {
          lineNumber: 1,
          description: 'A Gravel 19mm',
          poNumber: '482913',
          quantity: 73.8,
          unit: 'tonnes',
          unitRate: 18,
          lineTotal: 1328.4,
          flag: 'OK',
        },
      },
    },
    include: { lineItems: true },
  });

  return invoice.lineItems[0]!.id;
}

const linkedIds = async (lineItemId: string) => {
  const line = await prisma.invoiceLineItem.findUniqueOrThrow({
    where: { id: lineItemId },
    include: { matchedTickets: { select: { id: true } } },
  });
  return line.matchedTickets.map((t) => t.id).sort();
};

describe('manual ticket linking', { skip: !runnable }, () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it('adds each load instead of replacing the one before it', async () => {
    const lineItemId = await seed();

    await InvoiceService.linkTicketsToLineItem(lineItemId, [TICKET_IDS[0]!], USER_ID);
    assert.deepEqual(await linkedIds(lineItemId), [TICKET_IDS[0]]);

    // The second link is where this used to go wrong: the first disappeared.
    await InvoiceService.linkTicketsToLineItem(lineItemId, [TICKET_IDS[1]!], USER_ID);
    assert.deepEqual(await linkedIds(lineItemId), [TICKET_IDS[0], TICKET_IDS[1]].sort());

    await InvoiceService.linkTicketsToLineItem(lineItemId, [TICKET_IDS[2]!], USER_ID);
    assert.deepEqual(await linkedIds(lineItemId), [...TICKET_IDS].sort());
  });

  it('linking the same load twice leaves one link, not two', async () => {
    const lineItemId = await seed();

    await InvoiceService.linkTicketsToLineItem(lineItemId, [TICKET_IDS[0]!], USER_ID);
    await InvoiceService.linkTicketsToLineItem(lineItemId, [TICKET_IDS[0]!], USER_ID);

    assert.deepEqual(await linkedIds(lineItemId), [TICKET_IDS[0]]);
  });

  it('unlinking removes only the load named', async () => {
    const lineItemId = await seed();

    await InvoiceService.linkTicketsToLineItem(
      lineItemId,
      [TICKET_IDS[0]!, TICKET_IDS[1]!],
      USER_ID
    );
    await InvoiceService.unlinkTicketFromLineItem(lineItemId, TICKET_IDS[0]!, USER_ID);

    assert.deepEqual(await linkedIds(lineItemId), [TICKET_IDS[1]]);
  });
});
