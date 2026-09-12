import './setupEnv.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { applyBackfill, planBackfill } from '../src/scripts/backfillTicketClaims.js';

/**
 * Claiming loads that were spent before claims existed.
 *
 * The protection this backfills is worthless on the client's existing data
 * without it: every invoice verified before the feature shipped left its tickets
 * looking available, so a repeat bill would match cleanly. What matters most here
 * is the contested case — two settled lines holding one load is a double payment
 * that has probably already happened, and the run must surface it rather than
 * silently picking a winner.
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

const VERIFIED_AT = new Date('2026-07-01T12:00:00.000Z');

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TicketClaim", "AuditLog", "MatchResult", "TicketOrderMatch", ' +
      '"InvoiceLineItem", "Invoice", "Ticket", "Order", "NegotiatedRate", ' +
      '"SupplierProductAlias", "Supplier", "User" RESTART IDENTITY CASCADE'
  );

  await prisma.user.create({
    data: {
      id: USER_ID,
      name: 'Jane',
      email: 'jane@example.invalid',
      passwordHash: 'not-a-real-hash',
      role: 'AP_USER',
    },
  });
  await prisma.supplier.create({
    data: { id: SUPPLIER_ID, name: 'Millbrook', type: 'SUPPLIER', emailDomains: [] },
  });
}

let ticketSeq = 0;

async function makeTicket(): Promise<{ id: string; ticketNumber: string }> {
  ticketSeq += 1;
  const ticketNumber = `T-${900 + ticketSeq}`;
  const ticket = await prisma.ticket.create({
    data: {
      source: 'MANUAL',
      supplierId: SUPPLIER_ID,
      ticketNumber,
      poNumber: '551100',
      material: 'A Gravel 19mm',
      quantity: 20,
      unit: 'tonnes',
      ticketDate: new Date('2026-06-30'),
      imageUrl: '/uploads/none.png',
      ocrRawText: '',
      ocrConfidence: 0.9,
      status: 'LINKED',
    },
  });
  return { id: ticket.id, ticketNumber };
}

let invoiceSeq = 0;

/** One invoice, one line, holding the given tickets through the legacy join. */
async function makeInvoice(options: {
  status: 'VERIFIED' | 'PAID' | 'PENDING_REVIEW';
  ticketIds: string[];
  verifier?: string | null;
}): Promise<{ invoiceNumber: string; lineId: string }> {
  invoiceSeq += 1;
  const invoiceNumber = `OLD-${1000 + invoiceSeq}`;
  const settled = options.status !== 'PENDING_REVIEW';
  const verifier = options.verifier === undefined ? USER_ID : options.verifier;

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      senderType: 'SUPPLIER',
      supplierId: SUPPLIER_ID,
      invoiceDate: new Date('2026-06-30'),
      totalAmount: 360,
      currency: 'CAD',
      fileUrl: '/uploads/none.pdf',
      emailFrom: 'ap@millbrook.example',
      emailSubject: invoiceNumber,
      gmailMessageId: `backfill-${invoiceNumber}`,
      ocrRawText: '',
      status: options.status,
      ...(settled && verifier ? { verifiedById: verifier, verifiedAt: VERIFIED_AT } : {}),
      ...(settled && !verifier ? { verifiedAt: VERIFIED_AT } : {}),
      lineItems: {
        create: {
          lineNumber: 1,
          description: 'A Gravel 19mm',
          poNumber: '551100',
          quantity: 20,
          unit: 'tonnes',
          unitRate: 18,
          lineTotal: 360,
          flag: 'OK',
          matchedTickets: { connect: options.ticketIds.map((id) => ({ id })) },
        },
      },
    },
    include: { lineItems: true },
  });

  return { invoiceNumber, lineId: invoice.lineItems[0]!.id };
}

describe('backfilling claims for loads already paid for', { skip: !runnable }, () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it('claims a load one settled invoice holds, attributed to its verifier', async () => {
    await reset();
    const ticket = await makeTicket();
    const { lineId } = await makeInvoice({ status: 'VERIFIED', ticketIds: [ticket.id] });

    const plan = await planBackfill();
    assert.equal(plan.claimable.length, 1);
    assert.equal(plan.claimable[0]!.ticketId, ticket.id);
    assert.equal(plan.claimable[0]!.holder.lineId, lineId);
    assert.equal(plan.claimable[0]!.holder.verifiedById, USER_ID);
    assert.equal(plan.contested.length, 0);
  });

  it('writes the claim dated when the money actually went out', async () => {
    await reset();
    const ticket = await makeTicket();
    const { lineId } = await makeInvoice({ status: 'PAID', ticketIds: [ticket.id] });

    const { written, failures } = await applyBackfill(await planBackfill());
    assert.equal(written, 1);
    assert.deepEqual(failures, []);

    const claim = await prisma.ticketClaim.findUniqueOrThrow({ where: { ticketId: ticket.id } });
    assert.equal(claim.invoiceLineId, lineId);
    assert.equal(claim.claimedById, USER_ID);
    // Backdated on purpose: the audit trail must not say this decision was made
    // the day the backfill ran.
    assert.equal(claim.claimedAt.toISOString(), VERIFIED_AT.toISOString());

    // And a second pass is a no-op rather than a crash or a duplicate.
    const second = await applyBackfill(await planBackfill());
    assert.equal(second.written, 0);
    assert.equal(await prisma.ticketClaim.count({ where: { ticketId: ticket.id } }), 1);
  });

  it('refuses to pick a winner when two settled lines hold one load', async () => {
    await reset();
    const ticket = await makeTicket();
    const first = await makeInvoice({ status: 'VERIFIED', ticketIds: [ticket.id] });
    const second = await makeInvoice({ status: 'PAID', ticketIds: [ticket.id] });

    const plan = await planBackfill();

    // This is a load billed on two settled invoices: money may already have gone
    // out twice. Claiming either one would hide it.
    assert.equal(plan.claimable.length, 0, 'a contested load must not be claimed');
    assert.equal(plan.contested.length, 1);

    const contested = plan.contested[0]!;
    assert.equal(contested.ticketNumber, ticket.ticketNumber);
    const reported = contested.holders.map((holder) => holder.invoiceNumber).sort();
    assert.deepEqual(reported, [first.invoiceNumber, second.invoiceNumber].sort());
  });

  it('leaves unsettled invoices alone', async () => {
    await reset();
    const ticket = await makeTicket();
    await makeInvoice({ status: 'PENDING_REVIEW', ticketIds: [ticket.id] });

    const plan = await planBackfill();

    // Nobody has accepted this invoice, so its loads are not spent. Claiming
    // them would block whichever invoice turns out to be the real one.
    assert.equal(plan.claimable.length, 0);
    assert.equal(plan.contested.length, 0);
    assert.equal(plan.unattributed.length, 0);
  });

  it('reports a settled invoice with no verifier instead of guessing one', async () => {
    await reset();
    const ticket = await makeTicket();
    await makeInvoice({ status: 'VERIFIED', ticketIds: [ticket.id], verifier: null });

    const plan = await planBackfill();

    assert.equal(plan.claimable.length, 0);
    assert.equal(plan.unattributed.length, 1);
    assert.equal(plan.unattributed[0]!.ticketId, ticket.id);
  });

  it('skips loads that already have a claim, so it can be re-run', async () => {
    await reset();
    const ticket = await makeTicket();
    const { lineId } = await makeInvoice({ status: 'VERIFIED', ticketIds: [ticket.id] });

    await prisma.ticketClaim.create({
      data: { ticketId: ticket.id, invoiceLineId: lineId, claimedById: USER_ID },
    });

    const plan = await planBackfill();
    assert.equal(plan.claimable.length, 0);
    assert.equal(plan.alreadyClaimed, 1);
  });
});
