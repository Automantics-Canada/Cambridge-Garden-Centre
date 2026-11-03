import './setupEnv.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { matchInvoiceById } from '../src/modules/matching/matching.service.js';
import { reopenMatchResult, resolveMatchResult } from '../src/modules/matching/resolveMatch.js';
import { InvoiceService } from '../src/modules/invoices/invoice.service.js';

/**
 * Trucking invoices against the dispatch loads they bill, in PostgreSQL
 * (client, Oct 2026, Q14: "the dispatcher sets the rate for each load
 * dispatched and it is matched up when the invoice comes in").
 *
 * What a bug here would cost: a haul paid twice, paid at a rate nobody
 * agreed, or paid through the pit's ticket claim. So the properties proved are
 * that the dispatcher's rate is what the line is checked and approved
 * against, that a load is claimed on DispatchLoad only when a person (or a
 * clean verify) commits the money, that a second invoice for the same load is
 * refused even when both are confirmed at the same moment, and that reopening
 * or rejecting gives the load back.
 *
 * Every name and number is invented. Needs a disposable loopback database:
 *
 *   CGC_TEST_CONFIRM_DISPOSABLE=1 DATABASE_URL=postgresql://…@127.0.0.1:…/… \
 *     npx tsx --test tests/haulMatching.integration.test.ts
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

const USER_ID = '55555555-5555-4555-8555-5555555555c1';
const CARRIER_ID = '11111111-1111-4111-8111-1111111111c1';
const PIT_ID = '11111111-1111-4111-8111-1111111111c2';
const DAY = new Date('2026-10-28T00:00:00.000Z');
const INVOICE_DAY = new Date('2026-10-31T00:00:00.000Z');

let orderLines: Record<'A' | 'B', string>;
let loads: Record<'A' | 'B', string>;
let invoiceCounter = 0;

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TicketClaim", "MatchResult", "InvoiceSupportingFile", "InvoiceLineItem", "Invoice", "Ticket", ' +
      '"DispatchLoad", "Delivery", "Order", "OrderDocument", "NegotiatedRate", "SupplierProductAlias", "Supplier", ' +
      '"AuditLog", "User", "SystemSetting" RESTART IDENTITY CASCADE'
  );
  await prisma.user.create({
    data: { id: USER_ID, name: 'Example Desk', email: 'desk-haul@example.invalid', passwordHash: 'not-a-real-hash', role: 'AP_USER' },
  });
  await prisma.supplier.create({
    data: { id: CARRIER_ID, name: 'Example Haulage Ltd.', type: 'TRUCKING_COMPANY', emailDomains: [] },
  });
  await prisma.supplier.create({ data: { id: PIT_ID, name: 'Example Pit Inc.', type: 'SUPPLIER', emailDomains: [] } });

  const lineIds: Record<string, string> = {};
  const loadIds: Record<string, string> = {};
  for (const [key, number, po, ticket] of [
    ['A', '990101', '2608-700001', 'TK-7001'],
    ['B', '990102', '2608-700002', 'TK-7002'],
  ] as const) {
    const document = await prisma.orderDocument.create({
      data: { documentNumber: number, customerName: 'Example Customer', deliveryDate: DAY, poNumber: po },
    });
    const line = await prisma.order.create({
      data: {
        spruceOrderId: `${number}-L1`, documentId: document.id, lineNumber: 1, customerName: 'Example Customer',
        product: 'Example Screened Topsoil', quantity: '20', unit: 'MT', supplierId: PIT_ID, poNumber: po,
        orderDate: DAY, deliveryDate: DAY,
      },
    });
    const load = await prisma.dispatchLoad.create({
      data: {
        documentId: document.id, sequence: 1, carrierSupplierId: CARRIER_ID, rate: '185', rateUnit: 'LOAD',
        ticketNumber: ticket, setById: USER_ID,
      },
    });
    lineIds[key] = line.id;
    loadIds[key] = load.id;
  }
  orderLines = lineIds as typeof orderLines;
  loads = loadIds as typeof loads;
}

/** A trucking invoice with one line per entry, read as the extraction would store it. */
async function haulInvoice(
  lines: Array<{ ticketNumber?: string | null; poNumber?: string | null; unitRate?: number; quantity?: number; unit?: string }>,
  supplierId = CARRIER_ID
): Promise<{ invoiceId: string; lineIds: string[] }> {
  invoiceCounter += 1;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `HAUL-${String(invoiceCounter).padStart(4, '0')}`,
      senderType: supplierId === CARRIER_ID ? 'TRUCKING_COMPANY' : 'SUPPLIER',
      supplierId,
      invoiceDate: INVOICE_DAY,
      totalAmount: 0,
      currency: 'CAD',
      fileUrl: '/uploads/none.pdf',
      emailFrom: 'billing@example.invalid',
      emailSubject: 'Invoice',
      gmailMessageId: `haul-test-${invoiceCounter}-${Date.now()}`,
    },
  });
  const lineIds: string[] = [];
  for (const [index, entry] of lines.entries()) {
    const quantity = entry.quantity ?? 1;
    const unitRate = entry.unitRate ?? 185;
    const row = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        lineNumber: index + 1,
        description: 'Tri-axle haul',
        poNumber: entry.poNumber ?? null,
        ticketNumber: entry.ticketNumber ?? null,
        serviceDate: DAY,
        quantity,
        unit: entry.unit ?? 'load',
        unitRate,
        lineTotal: quantity * unitRate,
        flag: 'NO_ORDER',
      },
    });
    lineIds.push(row.id);
  }
  await matchInvoiceById(invoice.id);
  return { invoiceId: invoice.id, lineIds };
}

const verdictOf = (invoiceLineId: string) => prisma.matchResult.findUniqueOrThrow({ where: { invoiceLineId } });
const loadRow = (id: string) => prisma.dispatchLoad.findUniqueOrThrow({ where: { id } });

describe('trucking invoices against dispatch loads (PostgreSQL)', { skip: !runnable }, () => {
  beforeEach(reset);
  after(async () => {
    await prisma.$disconnect();
  });

  it('matches each line to its load at the dispatcher rate, and claims nothing until confirmed', async () => {
    const { lineIds } = await haulInvoice([{ ticketNumber: 'tk 7001' }, { ticketNumber: '#TK-7002' }]);

    for (const [index, key] of (['A', 'B'] as const).entries()) {
      const verdict = await verdictOf(lineIds[index]!);
      assert.equal(verdict.status, 'MATCHED', verdict.reason);
      assert.deepEqual(verdict.loadIds, [loads[key]]);
      assert.deepEqual(verdict.ticketIds, []);
      assert.equal(verdict.orderId, orderLines[key]);
      const line = await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: lineIds[index]! } });
      assert.equal(Number(line.negotiatedRate), 185);
      assert.equal(Number(line.approvedTotal), 185);
      assert.equal(line.flag, 'OK');
      assert.equal(line.matchedOrderId, orderLines[key]);
    }
    assert.equal((await loadRow(loads.A)).claimedByLineItemId, null, 'a verdict is not a payment');
  });

  it('verifying the invoice claims its loads on DispatchLoad, never through TicketClaim', async () => {
    const { invoiceId, lineIds } = await haulInvoice([{ ticketNumber: 'TK-7001' }, { ticketNumber: 'TK-7002' }]);
    await InvoiceService.verifyInvoice(invoiceId, USER_ID);

    const [a, b] = await Promise.all([loadRow(loads.A), loadRow(loads.B)]);
    assert.equal(a.claimedByLineItemId, lineIds[0]);
    assert.equal(b.claimedByLineItemId, lineIds[1]);
    assert.ok(a.claimedAt instanceof Date);
    assert.equal(await prisma.ticketClaim.count(), 0);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actionType: 'MATCH_RESOLVED', entityId: lineIds[0]! },
    });
    assert.deepEqual((audit.details as { claimedLoadIds?: string[] }).claimedLoadIds, [loads.A]);
  });

  it('a second invoice for a paid load is LOAD_ALREADY_CLAIMED and cannot be confirmed', async () => {
    const first = await haulInvoice([{ ticketNumber: 'TK-7001' }]);
    const firstVerdict = await verdictOf(first.lineIds[0]!);
    assert.equal((await resolveMatchResult({ matchResultId: firstVerdict.id, resolution: 'CONFIRMED', userId: USER_ID })).ok, true);

    const second = await haulInvoice([{ ticketNumber: 'TK-7001' }]);
    const verdict = await verdictOf(second.lineIds[0]!);
    assert.equal(verdict.status, 'PARTIAL');
    const reuse = (verdict.evidence as Array<{ name: string; code?: string; detail: string }>).find(
      (check) => check.name === 'loadReuse'
    );
    assert.equal(reuse?.code, 'LOAD_ALREADY_CLAIMED');
    assert.match(reuse!.detail, /HAUL-0+\d+ line 1/);

    const refused = await resolveMatchResult({ matchResultId: verdict.id, resolution: 'CONFIRMED', userId: USER_ID });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, 'LOAD_ALREADY_CLAIMED');
    assert.equal((await loadRow(loads.A)).claimedByLineItemId, first.lineIds[0]);
  });

  it('reopening the paid line gives the load back, and the waiting invoice is re-checked', async () => {
    const first = await haulInvoice([{ ticketNumber: 'TK-7001' }]);
    const firstVerdict = await verdictOf(first.lineIds[0]!);
    await resolveMatchResult({ matchResultId: firstVerdict.id, resolution: 'CONFIRMED', userId: USER_ID });
    const second = await haulInvoice([{ ticketNumber: 'TK-7001' }]);
    assert.equal((await verdictOf(second.lineIds[0]!)).status, 'PARTIAL');

    const reopened = await reopenMatchResult({ matchResultId: firstVerdict.id, userId: USER_ID, note: 'Wrong invoice.' });
    assert.equal(reopened.ok, true);
    const load = await loadRow(loads.A);
    assert.equal(load.claimedByLineItemId, null);
    assert.equal(load.claimedAt, null);

    // The load is free again, so it is no longer "already paid"; but both
    // invoices now bill it and neither is settled, which is for a person.
    const evidence = (await verdictOf(second.lineIds[0]!)).evidence as Array<{ name: string; passed: boolean; detail: string }>;
    assert.equal(evidence.find((check) => check.name === 'loadReuse')?.passed, true);
    const duplicate = evidence.find((check) => check.name === 'duplicateBilling');
    assert.equal(duplicate?.passed, false);
    assert.match(duplicate!.detail, /HAUL-0+\d+ line 1/);
  });

  it('rejecting a line leaves its load unpaid', async () => {
    const { lineIds } = await haulInvoice([{ ticketNumber: 'TK-7002' }]);
    const verdict = await verdictOf(lineIds[0]!);
    const outcome = await resolveMatchResult({
      matchResultId: verdict.id, resolution: 'REJECTED', note: 'Not our load.', userId: USER_ID,
    });
    assert.equal(outcome.ok, true);
    assert.equal((await loadRow(loads.B)).claimedByLineItemId, null);
  });

  it('two invoices confirmed at the same moment cannot both pay one load', async () => {
    // Both verdicts are computed before either is confirmed, so neither says
    // the load is paid. The second sees the first as an unreviewed repeat,
    // which a clerk may still confirm with a reason; only the claim inside
    // the transaction stops the load being paid twice.
    const one = await haulInvoice([{ ticketNumber: 'TK-7002' }]);
    const two = await haulInvoice([{ ticketNumber: 'TK-7002' }]);
    const [v1, v2] = await Promise.all([verdictOf(one.lineIds[0]!), verdictOf(two.lineIds[0]!)]);
    assert.equal(v1.status, 'MATCHED');
    assert.equal(v2.status, 'PARTIAL');
    assert.ok((v2.evidence as Array<{ name: string }>).some((check) => check.name === 'duplicateBilling'));

    const note = 'Checked with the carrier.';
    const outcomes = await Promise.all([
      resolveMatchResult({ matchResultId: v1.id, resolution: 'CONFIRMED', note, userId: USER_ID }),
      resolveMatchResult({ matchResultId: v2.id, resolution: 'CONFIRMED', note, userId: USER_ID }),
    ]);
    const won = outcomes.filter((outcome) => outcome.ok);
    const lost = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(won.length, 1, JSON.stringify(outcomes));
    assert.equal(lost.length, 1);
    assert.equal(!lost[0]!.ok && lost[0]!.code, 'LOAD_ALREADY_CLAIMED');

    const load = await loadRow(loads.B);
    const winner = outcomes[0]!.ok ? one.lineIds[0] : two.lineIds[0];
    assert.equal(load.claimedByLineItemId, winner);
    // The losing verdict is still open, not half-resolved.
    const loser = outcomes[0]!.ok ? v2 : v1;
    assert.equal((await prisma.matchResult.findUniqueOrThrow({ where: { id: loser.id } })).resolution, null);
  });

  it('one line for a brokered trip claims every load of the trip', async () => {
    await prisma.dispatchLoad.updateMany({ where: { id: { in: [loads.A, loads.B] } }, data: { tripRef: 'TRIP-5' } });
    const { lineIds } = await haulInvoice([{ poNumber: '700002' }]);
    const verdict = await verdictOf(lineIds[0]!);
    assert.equal(verdict.status, 'MATCHED', verdict.reason);
    assert.deepEqual(new Set(verdict.loadIds), new Set([loads.A, loads.B]));
    assert.equal((await resolveMatchResult({ matchResultId: verdict.id, resolution: 'CONFIRMED', userId: USER_ID })).ok, true);
    assert.equal((await loadRow(loads.A)).claimedByLineItemId, lineIds[0]);
    assert.equal((await loadRow(loads.B)).claimedByLineItemId, lineIds[0]);
  });

  it('a rate above the dispatcher rate is RATE_MISMATCH, approved at the dispatcher rate', async () => {
    const { lineIds } = await haulInvoice([{ ticketNumber: 'TK-7001', unitRate: 190, quantity: 2 }]);
    const verdict = await verdictOf(lineIds[0]!);
    assert.equal(verdict.status, 'PARTIAL');
    const line = await prisma.invoiceLineItem.findUniqueOrThrow({ where: { id: lineIds[0]! } });
    assert.equal(line.flag, 'RATE_MISMATCH');
    assert.equal(Number(line.negotiatedRate), 185);
    assert.equal(Number(line.rateDiscrepancy), 5);
    assert.equal(Number(line.approvedTotal), 370);
  });

  it('an override to the other order claims that order\'s load', async () => {
    const { lineIds } = await haulInvoice([{ ticketNumber: null, poNumber: null }]);
    const verdict = await verdictOf(lineIds[0]!);
    assert.equal(verdict.status, 'CONFLICT', verdict.reason);

    const confirmedConflict = await resolveMatchResult({ matchResultId: verdict.id, resolution: 'CONFIRMED', userId: USER_ID });
    assert.equal(!confirmedConflict.ok && confirmedConflict.code, 'LOAD_CHOICE_REQUIRED');

    const outcome = await resolveMatchResult({
      matchResultId: verdict.id, resolution: 'OVERRIDDEN', orderId: orderLines.B, note: 'Dispatch says the second order.', userId: USER_ID,
    });
    assert.equal(outcome.ok, true);
    assert.equal((await loadRow(loads.B)).claimedByLineItemId, lineIds[0]);
    assert.equal((await loadRow(loads.A)).claimedByLineItemId, null);
    assert.deepEqual((await verdictOf(lineIds[0]!)).loadIds, [loads.B]);
  });

  it('a material supplier\'s invoice keeps the order-and-ticket path', async () => {
    const { lineIds } = await haulInvoice([{ ticketNumber: 'TK-7001', poNumber: '2608-700001', unit: 'MT' }], PIT_ID);
    const verdict = await verdictOf(lineIds[0]!);
    const names = (verdict.evidence as Array<{ name: string }>).map((check) => check.name);
    assert.ok(names.includes('po'));
    assert.ok(!names.includes('haulLoad'));
    assert.deepEqual(verdict.loadIds, []);
  });

  it('re-reading an invoice whose haul is paid is refused, naming the load', async () => {
    const { invoiceId, lineIds } = await haulInvoice([{ ticketNumber: 'TK-7001' }]);
    await resolveMatchResult({ matchResultId: (await verdictOf(lineIds[0]!)).id, resolution: 'CONFIRMED', userId: USER_ID });
    await assert.rejects(() => InvoiceService.processInvoiceOcr(invoiceId), /1 paid dispatch load/);
  });

  it('deleting the paying line clears the claim', async () => {
    const { lineIds } = await haulInvoice([{ ticketNumber: 'TK-7001' }]);
    await resolveMatchResult({ matchResultId: (await verdictOf(lineIds[0]!)).id, resolution: 'CONFIRMED', userId: USER_ID });
    await prisma.invoiceLineItem.delete({ where: { id: lineIds[0]! } });
    assert.equal((await loadRow(loads.A)).claimedByLineItemId, null);
  });

  it('the invoice page shows the matched load with the dispatcher rate', async () => {
    const { invoiceId, lineIds } = await haulInvoice([{ ticketNumber: 'TK-7002' }]);
    const invoice = await InvoiceService.getInvoiceById(invoiceId);
    const item = invoice!.lineItems.find((entry) => entry.id === lineIds[0]) as unknown as {
      haulLoads: Array<Record<string, unknown>>;
    };
    assert.deepEqual(item.haulLoads, [
      {
        id: loads.B,
        documentNumber: '990102',
        sequence: 1,
        carrierName: 'Example Haulage Ltd.',
        rate: 185,
        rateUnit: 'LOAD',
        quantity: null,
        tripRef: null,
        ticketNumber: 'TK-7002',
        claimedByLineItemId: null,
      },
    ]);
  });
});
