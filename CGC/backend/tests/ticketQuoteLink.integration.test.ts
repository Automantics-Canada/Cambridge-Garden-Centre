import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { TicketService } from '../src/modules/tickets/ticket.service.js';

/**
 * A ticket is never linked by hand to a line of a quotation, against a real
 * database. A quotation is a price given to a customer, not an order, so
 * nothing was delivered against it. The Tickets page's order search no longer
 * offers one; this is the refusal behind it, for a screen open from before.
 *
 * Every name and number here is invented. Needs a disposable database; skips
 * without one.
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

const TICKET_ID = '55555555-5555-4555-8555-5555555555c1';
const lines: Record<'quote' | 'order' | 'loose', string> = { quote: '', order: '', loose: '' };

async function seed() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TicketOrderMatch", "Ticket", "Order", "OrderDocument" RESTART IDENTITY CASCADE'
  );
  await prisma.ticket.create({
    data: {
      id: TICKET_ID, source: 'MANUAL', ticketNumber: 'T-0001', imageUrl: '/uploads/none.png',
      ocrRawText: '', ocrConfidence: 0.9, status: 'UNLINKED',
    },
  });
  const document = (documentNumber: string, flags: string[]) =>
    prisma.orderDocument.create({
      data: {
        documentNumber, customerName: 'Example Yard Co', flags,
        lines: { create: { spruceOrderId: `${documentNumber}-L1`, lineNumber: 1, customerName: 'Example Yard Co', product: 'Gravel' } },
      },
      include: { lines: true },
    });
  lines.quote = (await document('9900-000001', ['QUOTE'])).lines[0]!.id;
  lines.order = (await document('9900-000002', [])).lines[0]!.id;
  // A line from before orders were grouped has no order to say: allowed.
  lines.loose = (await prisma.order.create({ data: { spruceOrderId: 'LOOSE-1', customerName: 'Loose Line Co', product: 'Sand' } })).id;
}

const refused = (err: any) =>
  err.status === 409 && err.message === '9900-000001 is a quotation in Spruce, not an order, so a ticket cannot be linked to it.';

describe('linking a ticket to a quotation', { skip: !runnable && 'needs CGC_TEST_CONFIRM_DISPOSABLE=1 and a loopback DATABASE_URL' }, () => {
  before(seed);
  after(() => prisma.$disconnect());

  it('refuses a quotation\'s line, by either way a ticket is linked by hand', async () => {
    await assert.rejects(TicketService.linkTicketToOrder(TICKET_ID, lines.quote), refused);
    await assert.rejects(TicketService.updateTicket(TICKET_ID, { linkedOrderId: lines.quote }), refused);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKET_ID } });
    assert.equal(ticket.status, 'UNLINKED');
    assert.equal(ticket.linkedOrderId, null);
    assert.equal(await prisma.ticketOrderMatch.count(), 0);
  });

  it('still links an order\'s line, and a line with no order', async () => {
    await TicketService.linkTicketToOrder(TICKET_ID, lines.order);
    const linked = await TicketService.updateTicket(TICKET_ID, { linkedOrderId: lines.loose });
    assert.equal(linked.status, 'LINKED');
    assert.equal(linked.linkedOrderId, lines.loose);
    assert.equal(await prisma.ticketOrderMatch.count(), 1);
  });
});
