/**
 * `GET /api/invoices` used to be `findMany({ where, include: { lineItems: true } })`
 * with no `take` — the whole ledger, every line item, on every list screen. In
 * production that response measured 6.9 MB and 5.3 s, and the browser then did
 * the filtering and paging itself.
 *
 * These tests pin the bounded query the service builds now. Like
 * `ticketQuery.test.ts`, they exercise the pure predicate/paging builders, so
 * they need no database.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildInvoiceWhere,
  resolveInvoicePaging,
  DEFAULT_INVOICE_PAGE_SIZE,
  MAX_INVOICE_PAGE_SIZE,
} from '../src/modules/invoices/invoice.service.js';

describe('resolveInvoicePaging', () => {
  it('bounds an unparameterised request', () => {
    const { page, limit, skip } = resolveInvoicePaging();
    assert.equal(page, 1);
    assert.equal(limit, DEFAULT_INVOICE_PAGE_SIZE);
    assert.equal(skip, 0);
  });

  it('refuses to return the whole ledger when a caller asks for it', () => {
    // The previous frontend asked the Edge function for limit=1000.
    assert.equal(resolveInvoicePaging({ limit: 1000 }).limit, MAX_INVOICE_PAGE_SIZE);
    assert.equal(resolveInvoicePaging({ limit: 100000 }).limit, MAX_INVOICE_PAGE_SIZE);
  });

  it('never produces a negative offset', () => {
    assert.equal(resolveInvoicePaging({ page: -3 }).skip, 0);
    assert.equal(resolveInvoicePaging({ page: 0 }).skip, 0);
  });

  it('falls back to the default rather than zero rows', () => {
    assert.equal(resolveInvoicePaging({ limit: 0 }).limit, DEFAULT_INVOICE_PAGE_SIZE);
    assert.equal(resolveInvoicePaging({ limit: -10 }).limit, 1);
  });

  it('ignores junk instead of throwing or unbounding', () => {
    const { page, limit } = resolveInvoicePaging({
      page: 'abc' as never,
      limit: 'lots' as never,
    });
    assert.equal(page, 1);
    assert.equal(limit, DEFAULT_INVOICE_PAGE_SIZE);
  });

  it('offsets by whole pages', () => {
    assert.equal(resolveInvoicePaging({ page: 3, limit: 25 }).skip, 50);
    assert.equal(resolveInvoicePaging({ page: 2, limit: 10 }).skip, 10);
  });
});

describe('buildInvoiceWhere', () => {
  it('is empty when no filters are supplied', () => {
    assert.deepEqual(buildInvoiceWhere(), {});
    assert.deepEqual(buildInvoiceWhere({}), {});
  });

  it('maps the simple equality filters', () => {
    const where = buildInvoiceWhere({
      status: 'DISPUTED' as never,
      supplierId: 'sup-1',
      senderType: 'SUPPLIER' as never,
    });
    assert.equal(where.status, 'DISPUTED');
    assert.equal(where.supplierId, 'sup-1');
    assert.equal(where.senderType, 'SUPPLIER');
  });

  it('translates "flagged only" into a relation predicate', () => {
    // The browser used to compute this from the full line-item array.
    assert.deepEqual(buildInvoiceWhere({ flaggedOnly: true }).lineItems, {
      some: { flag: { not: 'OK' } },
    });
    assert.equal('lineItems' in buildInvoiceWhere({ flaggedOnly: false }), false);
  });

  it('builds a bounded date range', () => {
    const where = buildInvoiceWhere({
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-02-01'),
    });
    assert.ok(where.invoiceDate.gte instanceof Date);
    assert.ok(where.invoiceDate.lte instanceof Date);
    assert.ok(where.invoiceDate.gte < where.invoiceDate.lte);
  });

  it('supports an open-ended range', () => {
    const fromOnly = buildInvoiceWhere({ startDate: new Date('2026-01-01') });
    assert.ok(fromOnly.invoiceDate.gte instanceof Date);
    assert.equal(fromOnly.invoiceDate.lte, undefined);
  });

  it('searches the fields the UI offers', () => {
    const where = buildInvoiceWhere({ search: '  acme ' });
    assert.equal(where.OR.length, 3);
    for (const clause of where.OR) {
      const value = JSON.stringify(clause);
      assert.ok(value.includes('acme'), value);
      assert.ok(!value.includes('  acme '), 'search term must be trimmed');
      assert.ok(value.includes('insensitive'), 'search must be case-insensitive');
    }
  });

  it('ignores a whitespace-only search rather than matching everything', () => {
    assert.equal(buildInvoiceWhere({ search: '   ' }).OR, undefined);
    assert.equal(buildInvoiceWhere({ search: '' }).OR, undefined);
  });

  it('does not leak pagination into the predicate', () => {
    // page/limit belong to the query options. Leaking them in would filter on
    // columns that do not exist and make the count disagree with the rows.
    const where = buildInvoiceWhere({ page: 3, limit: 25, status: 'VERIFIED' as never });
    assert.deepEqual(Object.keys(where), ['status']);
  });

  it('produces an identical predicate for the list and the count', () => {
    const filters = {
      status: 'PENDING_REVIEW' as never,
      supplierId: 'sup-9',
      search: 'gravel',
      flaggedOnly: true,
      startDate: new Date('2026-03-01'),
    };
    assert.deepEqual(
      JSON.stringify(buildInvoiceWhere(filters)),
      JSON.stringify(buildInvoiceWhere(filters))
    );
  });

  it("does not mutate the caller's filters", () => {
    const filters = { search: ' x ', status: 'VERIFIED' as never };
    const snapshot = JSON.stringify(filters);
    buildInvoiceWhere(filters);
    assert.equal(JSON.stringify(filters), snapshot);
  });
});
