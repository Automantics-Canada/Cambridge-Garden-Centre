/**
 * `include: { relation: true }` returns every scalar column on that relation.
 *
 * The invoice endpoints used `verifiedBy: true`, and `User` carries
 * `passwordHash` — so `GET /invoices` and `GET /invoices/:id` serialized bcrypt
 * hashes of whoever verified an invoice to every AP_USER, OWNER and ADMIN.
 * The invoice detail query had the same shape for `driver`, exposing
 * `ratePerDelivery` / `ratePerTrip` and driver contact details.
 *
 * These tests pin the projections. They deliberately assert on the include
 * objects rather than on a live response, so they run with no database — the
 * same approach `ticketQuery.test.ts` takes for the tickets predicate.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VERIFIED_BY_PUBLIC_FIELDS,
  DRIVER_PUBLIC_FIELDS,
  INVOICE_LIST_SELECT,
  INVOICE_DETAIL_INCLUDE,
  DASHBOARD_INVOICE_SELECT,
  toInvoiceListRow,
} from '../src/modules/invoices/invoice.service.js';

/** Every scalar on `User` that must never reach a client. */
const USER_SECRETS = ['passwordHash'];
/** Commercial and personal `Driver` columns the invoice UI has no use for. */
const DRIVER_SENSITIVE = ['ratePerDelivery', 'ratePerTrip', 'phone', 'email'];

/**
 * Walks an arbitrarily nested Prisma include tree and collects the names of
 * relations expanded with a bare `true`. Those are the unprojected ones — the
 * exact shape that leaked in the first place.
 */
function bareTrueRelations(node: unknown, path = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (key === 'select') continue; // a select IS the projection
    if (value === true) {
      found.push(here);
    } else if (value && typeof value === 'object') {
      found.push(...bareTrueRelations(value, here));
    }
  }
  return found;
}

describe('invoice response projections', () => {
  it('keeps Dashboard recent rows on a minimal projection', () => {
    assert.equal('lineItems' in DASHBOARD_INVOICE_SELECT, false);
    assert.equal('verifiedBy' in DASHBOARD_INVOICE_SELECT, false);
    assert.deepEqual(DASHBOARD_INVOICE_SELECT.supplier.select, { id: true, name: true });
  });

  it('never selects a User secret', () => {
    for (const secret of USER_SECRETS) {
      assert.equal(
        secret in VERIFIED_BY_PUBLIC_FIELDS,
        false,
        `${secret} must not be selectable on verifiedBy`
      );
    }
  });

  it('never selects driver rates or contact details', () => {
    for (const field of DRIVER_SENSITIVE) {
      assert.equal(
        field in DRIVER_PUBLIC_FIELDS,
        false,
        `${field} must not be selectable on driver`
      );
    }
  });

  it('still exposes the only fields the UI reads', () => {
    // InvoiceDetailPage.jsx renders `invoice.verifiedBy?.name`, and
    // VerificationDesk.jsx renders `del.driver?.name`. Narrowing past these
    // would blank out the UI, so the projection has a floor as well as a ceiling.
    assert.equal(VERIFIED_BY_PUBLIC_FIELDS.name, true);
    assert.equal(DRIVER_PUBLIC_FIELDS.name, true);
  });

  it('projects verifiedBy on the list query', () => {
    assert.notEqual(
      (INVOICE_LIST_SELECT as Record<string, unknown>).verifiedBy,
      true,
      'verifiedBy: true re-introduces the passwordHash leak'
    );
    assert.deepEqual(INVOICE_LIST_SELECT.verifiedBy.select, VERIFIED_BY_PUBLIC_FIELDS);
  });

  it('keeps the list rows off the full line-item graph', () => {
    // The list screens render a count and a flagged badge. Selecting the line
    // items themselves is what made GET /api/invoices a 6.9 MB response.
    assert.deepEqual(INVOICE_LIST_SELECT._count.select, { lineItems: true });
    assert.deepEqual(INVOICE_LIST_SELECT.lineItems.select, { id: true });
    assert.ok(
      INVOICE_LIST_SELECT.lineItems.where,
      'the line-item select must stay filtered to flagged rows only'
    );
    assert.equal((INVOICE_LIST_SELECT as Record<string, unknown>).ocrRawText, undefined);
  });

  it('collapses the line-item aggregates into counters', () => {
    const row = toInvoiceListRow({
      id: 'inv-1',
      invoiceNumber: 'INV-1',
      _count: { lineItems: 7 },
      lineItems: [{ id: 'a' }, { id: 'b' }],
    });
    assert.equal(row.lineItemCount, 7);
    assert.equal(row.flaggedCount, 2);
    assert.equal('_count' in row, false, 'the Prisma aggregate must not reach the client');
    assert.equal('lineItems' in row, false, 'raw line items must not reach the list client');
  });

  it('reports zero counters when a row has no line items', () => {
    const row = toInvoiceListRow({ id: 'inv-2', _count: { lineItems: 0 }, lineItems: [] });
    assert.equal(row.lineItemCount, 0);
    assert.equal(row.flaggedCount, 0);
  });

  it('projects verifiedBy on the detail query', () => {
    assert.notEqual(
      (INVOICE_DETAIL_INCLUDE as Record<string, unknown>).verifiedBy,
      true,
      'verifiedBy: true re-introduces the passwordHash leak'
    );
    assert.deepEqual(INVOICE_DETAIL_INCLUDE.verifiedBy.select, VERIFIED_BY_PUBLIC_FIELDS);
  });

  it('projects the nested delivery driver on the detail query', () => {
    const driver =
      INVOICE_DETAIL_INCLUDE.lineItems.include.matchedOrder.include.deliveries.include.driver;
    assert.notEqual(driver as unknown, true, 'driver: true exposes negotiated rates');
    assert.deepEqual(driver.select, DRIVER_PUBLIC_FIELDS);
  });

  it('expands no user- or driver-typed relation with a bare true', () => {
    // Guards the whole tree, including relations added later.
    for (const include of [INVOICE_LIST_SELECT, INVOICE_DETAIL_INCLUDE]) {
      const bare = bareTrueRelations(include);
      for (const relation of bare) {
        const leaf = relation.split('.').pop() ?? '';
        assert.equal(
          ['verifiedBy', 'driver', 'user', 'createdBy', 'linkedBy'].includes(leaf),
          false,
          `${relation} is expanded with a bare true and may carry secrets`
        );
      }
    }
  });

  it('detects a bare true if one is re-introduced', () => {
    // Proves the guard above can actually fail, rather than passing vacuously.
    assert.deepEqual(
      bareTrueRelations({ a: { include: { verifiedBy: true } } }),
      ['a.include.verifiedBy']
    );
    assert.deepEqual(bareTrueRelations({ verifiedBy: { select: { id: true } } }), []);
  });
});
