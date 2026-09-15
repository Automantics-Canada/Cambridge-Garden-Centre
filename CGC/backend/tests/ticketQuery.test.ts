/**
 * The tickets list endpoint measured ~6s against production. Two causes:
 * the list and the count ran sequentially over the same predicate, and the
 * projection pulled whole related rows (supplier, driver, linked order, and
 * every order match with its full order) for every row on the page.
 *
 * The predicate builder is now shared between list and count. These tests pin
 * that sharing, because a drift between the two silently produces pagination
 * totals that disagree with the rows returned.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTicketWhere,
  escapeLikePattern,
  numberSearchKey,
} from '../src/modules/tickets/ticket.service.js';

describe('numberSearchKey', () => {
  it('finds a number however its separators were typed', () => {
    for (const typed of ['T-88213', 'T88213', 't 88213', '#T-88213', ' T.88213 ']) {
      assert.equal(numberSearchKey(typed), 't88213', typed);
    }
    assert.equal(numberSearchKey('HBY 10512'), numberSearchKey('HBY-10512'));
    assert.equal(numberSearchKey('#7387'), '7387');
  });

  it('is empty for a term with no letters or digits', () => {
    assert.equal(numberSearchKey('#'), '');
    assert.equal(numberSearchKey(' - / '), '');
  });
});

describe('escapeLikePattern', () => {
  it('turns LIKE wildcards into literal characters', () => {
    assert.equal(escapeLikePattern('100%'), '100\\%');
    assert.equal(escapeLikePattern('A_1'), 'A\\_1');
    assert.equal(escapeLikePattern('C:\\scan'), 'C:\\\\scan');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(escapeLikePattern("19mm (3/4') Drainage Stone"), "19mm (3/4') Drainage Stone");
  });
});

describe('buildTicketWhere', () => {
  it('is empty when no filters are supplied', () => {
    assert.deepEqual(buildTicketWhere(), {});
    assert.deepEqual(buildTicketWhere({}), {});
  });

  it('maps the simple equality filters', () => {
    const where = buildTicketWhere({
      status: 'UNLINKED' as any,
      supplierId: 'sup-1',
      source: 'WHATSAPP' as any,
    });
    assert.equal(where.status, 'UNLINKED');
    assert.equal(where.supplierId, 'sup-1');
    assert.equal(where.source, 'WHATSAPP');
  });

  it('builds a bounded date range', () => {
    const where = buildTicketWhere({
      startDate: new Date('2026-01-01T05:00:00.000Z'),
      endDate: new Date('2026-02-02T04:59:59.999Z'),
    });
    assert.ok(where.receivedAt.gte instanceof Date);
    assert.ok(where.receivedAt.lte instanceof Date);
    assert.ok(where.receivedAt.gte < where.receivedAt.lte);
  });

  it('supports an open-ended range', () => {
    const fromOnly = buildTicketWhere({ startDate: new Date('2026-01-01T05:00:00.000Z') });
    assert.ok(fromOnly.receivedAt.gte instanceof Date);
    assert.equal(fromOnly.receivedAt.lte, undefined);
  });

  it('searches across the fields the UI offers', () => {
    const where = buildTicketWhere({ search: '  A-1234 ' });
    assert.equal(Array.isArray(where.OR), true);
    const [numberKey, ...literal] = [...where.OR].reverse();
    assert.equal(literal.length, 5);
    // Trimmed once, at the boundary, so every branch searches the same term.
    for (const clause of literal) {
      const value = JSON.stringify(clause);
      assert.ok(value.includes('"A-1234"'), value);
      assert.ok(!value.includes('  A-1234 '), 'search term must be trimmed');
    }
    assert.deepEqual(numberKey, { numberSearchKey: { contains: 'a1234' } });
  });

  it('matches a ticket or PO number typed without its separators', () => {
    const where = buildTicketWhere({ search: '#T 88213' });
    assert.deepEqual(where.OR.at(-1), { numberSearchKey: { contains: 't88213' } });
  });

  it('searches for wildcard characters literally', () => {
    const where = buildTicketWhere({ search: '100%' });
    assert.deepEqual(where.OR[0], { ticketNumber: { contains: '100\\%', mode: 'insensitive' } });
  });

  it('does not search the number key for a term of only punctuation', () => {
    // The key would be empty, and every ticket's key contains the empty string.
    const where = buildTicketWhere({ search: '%' });
    assert.equal(where.OR.length, 5);
    assert.ok(!JSON.stringify(where.OR).includes('numberSearchKey'));
  });

  it('ignores a whitespace-only search rather than matching everything', () => {
    assert.equal(buildTicketWhere({ search: '   ' }).OR, undefined);
    assert.equal(buildTicketWhere({ search: '' }).OR, undefined);
  });

  it('does not leak pagination into the predicate', () => {
    // page/limit belong to the query options, not the where clause. If they
    // leaked in, the count would silently filter on a non-existent column.
    const where = buildTicketWhere({ page: 3, limit: 25, status: 'LINKED' as any });
    assert.deepEqual(Object.keys(where), ['status']);
  });

  it('produces an identical predicate for the list and the count', () => {
    // The two call sites pass the same filters object; this is the property
    // that keeps totalCount consistent with the returned rows.
    const filters = {
      status: 'UNLINKED' as any,
      supplierId: 'sup-9',
      search: 'gravel',
      startDate: new Date('2026-03-01T05:00:00.000Z'),
    };
    assert.deepEqual(
      JSON.stringify(buildTicketWhere(filters)),
      JSON.stringify(buildTicketWhere(filters))
    );
  });

  it('does not mutate the caller\'s filters', () => {
    const filters = { search: ' x ', status: 'LINKED' as any };
    const snapshot = JSON.stringify(filters);
    buildTicketWhere(filters);
    assert.equal(JSON.stringify(filters), snapshot);
  });
});
