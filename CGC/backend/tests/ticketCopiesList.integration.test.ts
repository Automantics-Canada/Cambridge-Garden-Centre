import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { TicketService } from '../src/modules/tickets/ticket.service.js';

/**
 * The Tickets page says which ticket is a second copy of which (client,
 * Oct 2026, Q15: some suppliers attach their tickets to the invoice email,
 * while most tickets come from the drivers).
 *
 * The supplier's emailed copy is linked to the driver's photo of the same
 * ticket (Ticket.duplicateOfTicketId). Without saying so, the list showed two
 * rows that look like two loads. These checks prove the list and the review
 * view carry what the page needs to label both rows, and nothing more.
 *
 * Every name and number is invented. Needs a disposable loopback database.
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

const SUPPLIER_ID = '77777777-7777-4777-8777-7777777777a1';
const ID = {
  driver: '77777777-7777-4777-8777-777777777701',
  emailed: '77777777-7777-4777-8777-777777777702',
  alone: '77777777-7777-4777-8777-777777777703',
} as const;

describe('ticket copies on the Tickets page', { skip: !runnable }, () => {
  before(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "TicketClaim", "MatchResult", "TicketOrderMatch", "OcrJob", "Ticket", "Supplier" RESTART IDENTITY CASCADE'
    );
    await prisma.supplier.create({
      data: { id: SUPPLIER_ID, name: 'Example Pavers Ltd.', type: 'SUPPLIER', emailDomains: [] },
    });
    const base = {
      imageUrl: '/uploads/none.png',
      ocrRawText: '',
      ocrConfidence: 0.9,
      status: 'UNLINKED' as const,
      supplierId: SUPPLIER_ID,
    };
    await prisma.ticket.create({
      data: { ...base, id: ID.driver, source: 'MANUAL', ticketNumber: 'EX-70001', receivedAt: new Date('2026-10-28T15:00:00Z') },
    });
    await prisma.ticket.create({
      data: {
        ...base, id: ID.emailed, source: 'EMAIL', ticketNumber: 'EX 70001', duplicateOfTicketId: ID.driver,
        receivedAt: new Date('2026-10-29T12:00:00Z'),
      },
    });
    await prisma.ticket.create({
      data: { ...base, id: ID.alone, source: 'MANUAL', ticketNumber: 'EX-70002', receivedAt: new Date('2026-10-28T16:00:00Z') },
    });
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('the list names the ticket an emailed copy duplicates, and the copies a ticket has', async () => {
    const rows = (await TicketService.getTickets({})) as unknown as Array<Record<string, unknown> & { id: string }>;
    const byId = new Map(rows.map((row) => [row.id, row]));

    const emailed = byId.get(ID.emailed)!;
    assert.equal(emailed.duplicateOfTicketId, ID.driver);
    assert.deepEqual(emailed.duplicateOf, { id: ID.driver, ticketNumber: 'EX-70001', source: 'MANUAL' });
    assert.deepEqual(emailed.copies, []);

    const driver = byId.get(ID.driver)!;
    assert.equal(driver.duplicateOfTicketId, null);
    assert.deepEqual(driver.copies, [{ id: ID.emailed, ticketNumber: 'EX 70001', source: 'EMAIL' }]);

    const alone = byId.get(ID.alone)!;
    assert.equal(alone.duplicateOf, null);
    assert.deepEqual(alone.copies, []);
  });

  it('the review view carries the same', async () => {
    const emailed = await TicketService.getTicketById(ID.emailed);
    assert.equal(emailed?.duplicateOf?.ticketNumber, 'EX-70001');
    const driver = await TicketService.getTicketById(ID.driver);
    assert.deepEqual(driver?.copies.map((copy) => copy.source), ['EMAIL']);
  });
});
