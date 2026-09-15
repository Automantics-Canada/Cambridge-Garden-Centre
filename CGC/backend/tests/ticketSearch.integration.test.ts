import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { TicketService, type TicketFilters } from '../src/modules/tickets/ticket.service.js';

/**
 * Ticket search, against a real database.
 *
 * The unit tests pin the predicate `buildTicketWhere` builds. Only Postgres can
 * show what that predicate finds: that the trigger fills `numberSearchKey` on
 * insert and on edit, that an escaped `%` really is literal under ILIKE, and
 * that the list and the count still agree.
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

const SUPPLIER_ID = '88888888-8888-4888-8888-88888888888a';
const ID = {
  gravel: '88888888-8888-4888-8888-888888888801',
  mulch: '88888888-8888-4888-8888-888888888802',
  surcharge: '88888888-8888-4888-8888-888888888803',
  underscore: '88888888-8888-4888-8888-888888888804',
  lookalike: '88888888-8888-4888-8888-888888888805',
  unread: '88888888-8888-4888-8888-888888888806',
} as const;

const NAME_BY_ID = Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, name]));

async function seed() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TicketClaim", "MatchResult", "TicketOrderMatch", "OcrJob", ' +
      '"Ticket", "Supplier" RESTART IDENTITY CASCADE'
  );

  await prisma.supplier.create({
    data: { id: SUPPLIER_ID, name: 'Millbrook Aggregates Ltd.', type: 'SUPPLIER', emailDomains: [] },
  });

  const base = {
    source: 'MANUAL' as const,
    imageUrl: '/uploads/none.png',
    ocrRawText: '',
    ocrConfidence: 0.9,
    status: 'UNLINKED' as const,
  };

  // Separate creates, not createMany: the trigger must fire per row the way it
  // does for every real upload.
  await prisma.ticket.create({
    data: { ...base, id: ID.gravel, ticketNumber: 'T-88213', poNumber: '482913',
      material: 'A Gravel 19mm', supplierId: SUPPLIER_ID, receivedAt: new Date('2026-09-14T11:00:00Z') },
  });
  await prisma.ticket.create({
    data: { ...base, id: ID.mulch, ticketNumber: 'HBY 10512', poNumber: '686174',
      material: 'Engineered PG Mulch', supplierName: 'GRO-BARK (ONTARIO) LTD.',
      receivedAt: new Date('2026-09-13T11:00:00Z') },
  });
  await prisma.ticket.create({
    data: { ...base, id: ID.surcharge, ticketNumber: '7387', poNumber: '351370',
      material: 'Fuel Surcharge; Delivery', receivedAt: new Date('2026-09-12T11:00:00Z') },
  });
  await prisma.ticket.create({
    data: { ...base, id: ID.underscore, ticketNumber: 'A_1', material: '100% recycled',
      receivedAt: new Date('2026-09-11T11:00:00Z') },
  });
  // Matches the two above only if `_` or `%` were still acting as wildcards.
  await prisma.ticket.create({
    data: { ...base, id: ID.lookalike, ticketNumber: 'AX1', material: '1000 recycled',
      receivedAt: new Date('2026-09-10T11:00:00Z') },
  });
  await prisma.ticket.create({
    data: { ...base, id: ID.unread, receivedAt: new Date('2026-09-09T11:00:00Z') },
  });
}

/** The tickets a search returns, by name, after checking the count agrees. */
async function find(search: string, extra: TicketFilters = {}): Promise<string[]> {
  const filters: TicketFilters = { ...extra, search, page: 1, limit: 50 };
  const [rows, total] = await Promise.all([
    TicketService.getTickets(filters),
    TicketService.countTickets(filters),
  ]);
  assert.equal(total, rows.length, `count disagrees with rows for ${JSON.stringify(search)}`);
  return rows.map((row: { id: string }) => NAME_BY_ID[row.id] ?? row.id).sort();
}

describe('ticket search', { skip: !runnable }, () => {
  before(seed);

  after(async () => {
    await prisma.$disconnect();
  });

  it('finds a ticket number typed without its dash, space or hash', async () => {
    for (const typed of ['T-88213', 'T88213', 't 88213', '#T-88213', '88213']) {
      assert.deepEqual(await find(typed), ['gravel'], typed);
    }
    for (const typed of ['HBY10512', 'hby-10512']) {
      assert.deepEqual(await find(typed), ['mulch'], typed);
    }
    assert.deepEqual(await find('#7387'), ['surcharge']);
  });

  it('still finds by PO, material and supplier', async () => {
    assert.deepEqual(await find('482913'), ['gravel']);
    assert.deepEqual(await find('gravel'), ['gravel']);
    assert.deepEqual(await find('millbrook'), ['gravel']);
    assert.deepEqual(await find('gro-bark'), ['mulch']);
  });

  it('treats % and _ as the characters typed, not wildcards', async () => {
    assert.deepEqual(await find('A_1'), ['underscore']);
    assert.deepEqual(await find('100%'), ['underscore']);
    assert.deepEqual(await find('%'), ['underscore']);
    assert.deepEqual(await find('_'), ['underscore']);
  });

  it('does not let a number match run from the ticket number into the PO', async () => {
    assert.deepEqual(await find('88213482913'), []);
  });

  it('keeps a search inside the other filters', async () => {
    assert.deepEqual(await find('T88213', { status: 'LINKED' as any }), []);
    assert.deepEqual(await find('T88213', { status: 'UNLINKED' as any }), ['gravel']);
  });

  it('finds a ticket by its new number as soon as the number is corrected', async () => {
    await prisma.ticket.update({ where: { id: ID.surcharge }, data: { ticketNumber: 'G 42332' } });
    assert.deepEqual(await find('G42332'), ['surcharge']);
    assert.deepEqual(await find('7387'), []);
  });
});
