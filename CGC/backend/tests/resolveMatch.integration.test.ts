import './setupEnv.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { matchTicketById } from '../src/modules/matching/matching.service.js';
import { reopenMatchResult, resolveMatchResult } from '../src/modules/matching/resolveMatch.js';

/**
 * A person settling a verdict, against a real database.
 *
 * These writes decide what gets paid, so the properties worth proving are the
 * ones a bug would hide: that a decision actually attaches the ticket to the
 * order the person chose, that it cannot be silently overwritten by someone
 * else, and that it leaves a record naming who decided and what the engine had
 * said instead.
 *
 * Needs a disposable database; skips without one.
 *
 *   CGC_TEST_CONFIRM_DISPOSABLE=1 \
 *   DATABASE_URL=postgresql://dev:dev@localhost:55433/cgc \
 *     npx tsx --test tests/resolveMatch.integration.test.ts
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
const ORDER_A = '22222222-2222-4222-8222-22222222222a';
const ORDER_B = '22222222-2222-4222-8222-22222222222b';
const TICKET_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '55555555-5555-4555-8555-555555555555';

async function seed(): Promise<string> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "MatchResult", "TicketOrderMatch", "InvoiceLineItem", ' +
      '"Invoice", "Ticket", "Order", "NegotiatedRate", "Supplier", "User" RESTART IDENTITY CASCADE'
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

  // Two orders on the same PO that nothing can tell apart: the CONFLICT a
  // person exists to settle.
  for (const [id, spruceId] of [
    [ORDER_A, 'DOC-A'],
    [ORDER_B, 'DOC-B'],
  ] as const) {
    await prisma.order.create({
      data: {
        id,
        spruceOrderId: spruceId,
        poNumber: '482913',
        customerName: 'A Customer',
        product: 'A Gravel 19mm',
        quantity: 24.6,
        unit: 'tonnes',
        supplierId: SUPPLIER_ID,
        orderDate: new Date('2026-08-13'),
      },
    });
  }

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

  const decision = await matchTicketById(TICKET_ID);
  assert.equal(decision?.status, 'CONFLICT', 'expected the seed to produce a CONFLICT');

  const result = await prisma.matchResult.findFirstOrThrow({ where: { ticketId: TICKET_ID } });
  return result.id;
}

describe('resolving a verdict', { skip: !runnable }, () => {
  let matchResultId: string;

  beforeEach(async () => {
    matchResultId = await seed();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('an override attaches the ticket to the order the person chose', async () => {
    const outcome = await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: ORDER_B,
      note: 'Confirmed with the yard: this load went to the second order.',
      userId: USER_ID,
    });
    assert.equal(outcome.ok, true);

    // A decision that changed nothing would be worse than none.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKET_ID } });
    assert.equal(ticket.linkedOrderId, ORDER_B);
    assert.equal(ticket.status, 'LINKED');

    const link = await prisma.ticketOrderMatch.findFirst({
      where: { ticketId: TICKET_ID, orderId: ORDER_B },
    });
    assert.equal(link?.matchMethod, 'HUMAN_OVERRIDE');
    assert.equal(link?.createdBy, USER_ID);
  });

  it('keeps the engine verdict intact, and records the decision beside it', async () => {
    await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: ORDER_A,
      note: 'Checked the delivery sheet.',
      userId: USER_ID,
    });

    const stored = await prisma.matchResult.findUniqueOrThrow({ where: { id: matchResultId } });
    // The status is still what was actually computed. Rewriting it to MATCHED
    // would destroy the only record of what had been checked.
    assert.equal(stored.status, 'CONFLICT');
    assert.equal(stored.resolution, 'OVERRIDDEN');
    assert.equal(stored.resolvedById, USER_ID);
    assert.ok(stored.resolvedAt);
    assert.match(stored.resolutionNote ?? '', /delivery sheet/);
  });

  it('leaves an audit entry naming the decider and what the engine had said', async () => {
    await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: ORDER_B,
      note: 'Second order.',
      userId: USER_ID,
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { actionType: 'MATCH_RESOLVED' },
    });
    assert.equal(entry.performedById, USER_ID);

    const details = entry.details as Record<string, unknown>;
    assert.equal(details.engineStatus, 'CONFLICT');
    assert.equal(details.resolvedOrderId, ORDER_B);
  });

  it('refuses to overwrite a decision somebody else already made', async () => {
    await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: ORDER_A,
      note: 'First.',
      userId: USER_ID,
    });

    const second = await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: ORDER_B,
      note: 'Second.',
      userId: USER_ID,
    });

    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.code, 'ALREADY_RESOLVED');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKET_ID } });
    assert.equal(ticket.linkedOrderId, ORDER_A, 'the first decision was overwritten');
  });

  it('an override without an order is refused', async () => {
    const outcome = await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      note: 'no order given',
      userId: USER_ID,
    });
    assert.equal(outcome.ok === false && outcome.code, 'ORDER_REQUIRED');
  });

  it('an override or rejection without a reason is refused', async () => {
    // Six months later the note is the only record of why the engine was
    // contradicted.
    for (const resolution of ['OVERRIDDEN', 'REJECTED'] as const) {
      const outcome = await resolveMatchResult({
        matchResultId,
        resolution,
        orderId: ORDER_A,
        userId: USER_ID,
      });
      assert.equal(outcome.ok === false && outcome.code, 'NOTE_REQUIRED');
    }
  });

  it('an order that does not exist is refused before anything is written', async () => {
    const outcome = await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: '99999999-9999-4999-8999-999999999999',
      note: 'typo',
      userId: USER_ID,
    });
    assert.equal(outcome.ok === false && outcome.code, 'ORDER_NOT_FOUND');

    const stored = await prisma.matchResult.findUniqueOrThrow({ where: { id: matchResultId } });
    assert.equal(stored.resolution, null);
  });

  it('a rejection detaches the ticket rather than leaving it pointing somewhere wrong', async () => {
    await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: ORDER_A,
      note: 'first',
      userId: USER_ID,
    });
    await reopenMatchResult({ matchResultId, userId: USER_ID });

    await resolveMatchResult({
      matchResultId,
      resolution: 'REJECTED',
      note: 'No order for this load; the driver picked up for another yard.',
      userId: USER_ID,
    });

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKET_ID } });
    assert.equal(ticket.linkedOrderId, null);
    assert.equal(ticket.status, 'UNLINKED');
  });

  it('reopening lets the decision be made again, and is itself recorded', async () => {
    await resolveMatchResult({
      matchResultId,
      resolution: 'OVERRIDDEN',
      orderId: ORDER_A,
      note: 'first',
      userId: USER_ID,
    });

    await reopenMatchResult({ matchResultId, userId: USER_ID, note: 'Wrong order picked.' });

    const stored = await prisma.matchResult.findUniqueOrThrow({ where: { id: matchResultId } });
    assert.equal(stored.resolution, null);
    assert.equal(stored.resolvedById, null);
    // The engine's own verdict survives a reopen untouched.
    assert.equal(stored.status, 'CONFLICT');

    const entry = await prisma.auditLog.findFirst({ where: { actionType: 'MATCH_REOPENED' } });
    assert.ok(entry, 'reopening was not recorded');
  });

  it('a reopened verdict is recomputed again, unlike a resolved one', async () => {
    await resolveMatchResult({
      matchResultId,
      resolution: 'CONFIRMED',
      userId: USER_ID,
    });
    await reopenMatchResult({ matchResultId, userId: USER_ID });

    // Remove one of the two orders so the CONFLICT can now be settled.
    await prisma.ticketOrderMatch.deleteMany({ where: { orderId: ORDER_B } });
    await prisma.matchResult.updateMany({ where: { orderId: ORDER_B }, data: { orderId: null } });
    await prisma.order.delete({ where: { id: ORDER_B } });

    const decision = await matchTicketById(TICKET_ID);
    assert.equal(decision?.status, 'MATCHED');

    const stored = await prisma.matchResult.findUniqueOrThrow({ where: { id: matchResultId } });
    assert.equal(stored.status, 'MATCHED');
  });
});
