import './setupEnv.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { matchInvoiceLineById } from '../src/modules/matching/matching.service.js';
import { reopenMatchResult, resolveMatchResult } from '../src/modules/matching/resolveMatch.js';
import { InvoiceService } from '../src/modules/invoices/invoice.service.js';

/**
 * Paying the same delivery twice, against a real database.
 *
 * The engine tests prove the decision. Only a database proves the rest: that a
 * claim is actually written when money is committed, that the unique constraint
 * holds when two people confirm competing lines at the same instant, and that
 * rejecting an invoice gives the load back rather than stranding it.
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

const USER_ID = '77777777-7777-4777-8777-777777777777';
const SUPPLIER_ID = '77777777-7777-4777-8777-77777777777a';
const ORDER_ID = '77777777-7777-4777-8777-77777777777b';
const TICKET_ID = '77777777-7777-4777-8777-77777777777c';

/** One load, billed on two separate invoices. */
async function seed(): Promise<{ lineA: string; lineB: string }> {
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
  await prisma.order.create({
    data: {
      id: ORDER_ID,
      spruceOrderId: 'DOC-CLAIM',
      poNumber: '482913',
      customerName: 'A Customer',
      product: 'A Gravel 19mm',
      quantity: 24.6,
      unit: 'tonnes',
      supplierId: SUPPLIER_ID,
      orderDate: new Date('2026-08-13'),
    },
  });
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

  const lineIds: string[] = [];
  for (const number of ['INV-1001', 'INV-1007']) {
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: number,
        senderType: 'SUPPLIER',
        supplierId: SUPPLIER_ID,
        invoiceDate: new Date('2026-08-14'),
        totalAmount: 442.8,
        currency: 'CAD',
        fileUrl: '/uploads/none.pdf',
        emailFrom: 'ap@millbrook.example',
        emailSubject: number,
        gmailMessageId: `claims-${number}`,
        ocrRawText: '',
        lineItems: {
          create: {
            lineNumber: 1,
            description: 'A Gravel 19mm',
            poNumber: '482913',
            quantity: 24.6,
            unit: 'tonnes',
            unitRate: 18,
            lineTotal: 442.8,
            flag: 'OK',
          },
        },
      },
      include: { lineItems: true },
    });
    lineIds.push(invoice.lineItems[0]!.id);
  }

  return { lineA: lineIds[0]!, lineB: lineIds[1]! };
}

const checksOf = (evidence: unknown) =>
  (evidence as Array<{ name: string; passed: boolean; detail: string }>) ?? [];

describe('one load pays one line', { skip: !runnable }, () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it('confirming one line spends the load and blocks the other', async () => {
    const { lineA, lineB } = await seed();

    await matchInvoiceLineById(lineA);
    const first = await prisma.matchResult.findFirstOrThrow({ where: { invoiceLineId: lineA } });

    // Two unreviewed invoices bill this PO, so neither is green for being first.
    assert.equal(first.status, 'PARTIAL');
    assert.equal(
      checksOf(first.evidence).find((c) => c.name === 'duplicateBilling')?.passed,
      false
    );

    // Confirming into contention demands a reason.
    const noNote = await resolveMatchResult({
      matchResultId: first.id,
      resolution: 'CONFIRMED',
      userId: USER_ID,
    });
    assert.equal(noNote.ok === false && noNote.code, 'NOTE_REQUIRED_DUPLICATE');

    const confirm = await resolveMatchResult({
      matchResultId: first.id,
      resolution: 'CONFIRMED',
      note: 'Checked with the yard: INV-1007 is the repeat.',
      userId: USER_ID,
    });
    assert.equal(confirm.ok, true);

    // The load is spent, and the record says which line spent it.
    const claim = await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: TICKET_ID } });
    assert.equal(claim.invoiceLineId, lineA);
    assert.equal(claim.claimedById, USER_ID);

    // The second invoice can no longer be covered by the same delivery.
    await matchInvoiceLineById(lineB);
    const second = await prisma.matchResult.findFirstOrThrow({ where: { invoiceLineId: lineB } });
    const reuse = checksOf(second.evidence).find((c) => c.name === 'ticketReuse');
    assert.equal(second.status, 'PARTIAL');
    assert.equal(reuse?.passed, false);
    assert.match(reuse?.detail ?? '', /INV-1001/);
    assert.match(reuse?.detail ?? '', /twice/);

    // And confirming it anyway is refused. One click must not double pay.
    const blocked = await resolveMatchResult({
      matchResultId: second.id,
      resolution: 'CONFIRMED',
      note: 'trying anyway',
      userId: USER_ID,
    });
    assert.equal(blocked.ok === false && blocked.code, 'TICKETS_ALREADY_CLAIMED');
  });

  it('reopening and rejecting gives the load back', async () => {
    const { lineA, lineB } = await seed();

    await matchInvoiceLineById(lineA);
    const first = await prisma.matchResult.findFirstOrThrow({ where: { invoiceLineId: lineA } });
    await resolveMatchResult({
      matchResultId: first.id,
      resolution: 'CONFIRMED',
      note: 'first call',
      userId: USER_ID,
    });
    assert.equal(await prisma.ticketClaim.count({ where: { ticketId: TICKET_ID } }), 1);

    // Somebody realises this was the repeat after all.
    await reopenMatchResult({ matchResultId: first.id, userId: USER_ID });
    assert.equal(
      await prisma.ticketClaim.count({ where: { ticketId: TICKET_ID } }),
      0,
      'reopening must un-spend the load'
    );

    await resolveMatchResult({
      matchResultId: first.id,
      resolution: 'REJECTED',
      note: 'This was the duplicate.',
      userId: USER_ID,
    });

    // The real invoice is payable again — a rejected duplicate must not strand
    // the load permanently.
    await matchInvoiceLineById(lineB);
    const second = await prisma.matchResult.findFirstOrThrow({ where: { invoiceLineId: lineB } });
    const reuse = checksOf(second.evidence).find((c) => c.name === 'ticketReuse');
    assert.notEqual(reuse?.passed, false);
  });

  it('an invoice with an unchecked line cannot be verified', async () => {
    const { lineA } = await seed();

    // No matching has run, so no verdict exists. This is not hypothetical:
    // matching is advisory during import, so an engine error leaves lines in
    // exactly this state — nothing checked, and nothing saying so.
    assert.equal(await prisma.matchResult.count({ where: { invoiceLineId: lineA } }), 0);

    const invoiceId = (
      await prisma.invoiceLineItem.findUniqueOrThrow({
        where: { id: lineA },
        select: { invoiceId: true },
      })
    ).invoiceId;

    await assert.rejects(
      () => InvoiceService.verifyInvoice(invoiceId, USER_ID),
      (error: Error & { status?: number }) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /not been checked/);
        return true;
      },
      'verifying a line nothing has evaluated would commit money against no evidence'
    );

    // And nothing was spent or marked verified on the way out.
    assert.equal(await prisma.ticketClaim.count(), 0);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    assert.notEqual(invoice.status, 'VERIFIED');
  });

  it('a load already paid for cannot be hand-linked to another line', async () => {
    const { lineA, lineB } = await seed();

    await matchInvoiceLineById(lineA);
    const first = await prisma.matchResult.findFirstOrThrow({ where: { invoiceLineId: lineA } });
    await resolveMatchResult({
      matchResultId: first.id,
      resolution: 'CONFIRMED',
      note: 'the real one',
      userId: USER_ID,
    });

    // The manual link predates the engine and writes no claim, so it must at
    // least refuse to attach a load somebody has already been paid for.
    await assert.rejects(
      () => InvoiceService.linkTicketsToLineItem(lineB, [TICKET_ID], USER_ID),
      (error: Error & { status?: number }) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /INV-1001/);
        return true;
      }
    );

    // Linking the line that already owns it is still allowed.
    await InvoiceService.linkTicketsToLineItem(lineA, [TICKET_ID], USER_ID);
  });

  it('two simultaneous confirmations cannot both spend the load', async () => {
    const { lineA, lineB } = await seed();
    await matchInvoiceLineById(lineA);
    await matchInvoiceLineById(lineB);

    const a = await prisma.matchResult.findFirstOrThrow({ where: { invoiceLineId: lineA } });
    const b = await prisma.matchResult.findFirstOrThrow({ where: { invoiceLineId: lineB } });

    // Both passed their checks a moment ago. The constraint is what decides.
    const results = await Promise.allSettled([
      resolveMatchResult({
        matchResultId: a.id,
        resolution: 'CONFIRMED',
        note: 'mine',
        userId: USER_ID,
      }),
      resolveMatchResult({
        matchResultId: b.id,
        resolution: 'CONFIRMED',
        note: 'mine',
        userId: USER_ID,
      }),
    ]);

    const won = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as { ok: boolean }).ok === true
    );
    assert.equal(won.length, 1, 'exactly one confirmation may spend the load');
    assert.equal(await prisma.ticketClaim.count({ where: { ticketId: TICKET_ID } }), 1);
  });
});
