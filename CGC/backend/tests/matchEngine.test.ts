import './setupEnv.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchInvoiceLine,
  matchTicket,
  type CandidateOrder,
  type InvoiceLineSubject,
  type MatchInputs,
  type TicketSubject,
} from '../src/modules/matching/matchEngine.js';
import { DEFAULT_TOLERANCES, resolveTolerances } from '../src/modules/matching/tolerances.js';

/**
 * The decisions that stand between a supplier's invoice and CGC's bank account.
 *
 * Every case here is one someone could actually be paid wrongly over, so the
 * tests are written around the money rather than around the branches: billed
 * for more than arrived, billed above the agreed rate, two customers' orders
 * that look alike, a unit nobody can compare.
 */

const SUPPLIER = 'supplier-1';
const OTHER_SUPPLIER = 'supplier-2';

function order(overrides: Partial<CandidateOrder> = {}): CandidateOrder {
  return {
    id: 'order-1',
    poNumber: '482913',
    product: 'A Gravel 19mm',
    quantity: 24.6,
    unit: 'tonnes',
    supplierId: SUPPLIER,
    orderDate: new Date('2026-08-13T00:00:00Z'),
    ...overrides,
  };
}

function ticket(overrides: Partial<TicketSubject> = {}): TicketSubject {
  return {
    id: 'ticket-1',
    poNumber: '482913',
    material: 'A Gravel 19mm',
    quantity: 24.6,
    unit: 'tonnes',
    supplierId: SUPPLIER,
    ticketDate: new Date('2026-08-13T00:00:00Z'),
    ...overrides,
  };
}

function invoiceLine(overrides: Partial<InvoiceLineSubject> = {}): InvoiceLineSubject {
  return {
    id: 'line-1',
    poNumber: '482913',
    description: 'A Gravel 19mm',
    quantity: 24.6,
    unit: 'tonnes',
    unitRate: 18,
    supplierId: SUPPLIER,
    invoiceDate: new Date('2026-08-13T00:00:00Z'),
    ...overrides,
  };
}

function inputs(overrides: Partial<MatchInputs> = {}): MatchInputs {
  return {
    orders: [order()],
    aliases: [],
    tolerances: DEFAULT_TOLERANCES,
    ...overrides,
  };
}

const check = (decision: { checks: Array<{ name: string; passed: boolean }> }, name: string) =>
  decision.checks.find((entry) => entry.name === name);

describe('matchTicket', () => {
  test('a ticket that agrees with its order on everything is MATCHED', () => {
    const decision = matchTicket(ticket(), inputs());
    assert.equal(decision.status, 'MATCHED');
    assert.equal(decision.orderId, 'order-1');
  });

  test('a short load beyond tolerance is PARTIAL, and says by how much', () => {
    // Ordered 24.6 tonnes, 22.0 arrived: 10.6% short, well past the 2% allowed.
    const decision = matchTicket(ticket({ quantity: 22 }), inputs());
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(decision.orderId, 'order-1');
    assert.match(decision.reason, /10\.6%/);
    assert.equal(check(decision, 'quantity')?.passed, false);
  });

  test('a quantity inside tolerance still passes', () => {
    // 24.9 against 24.6 is 1.2%, inside 2%. A truck scale is not exact and a
    // system that flagged this would be ignored within a week.
    const decision = matchTicket(ticket({ quantity: 24.9 }), inputs());
    assert.equal(decision.status, 'MATCHED');
  });

  test('a quantity exactly at the tolerance boundary passes', () => {
    const decision = matchTicket({ ...ticket(), quantity: 24.6 * 1.02 }, inputs());
    assert.equal(check(decision, 'quantity')?.passed, true);
  });

  test('tonnes are never compared against cubic yards', () => {
    // Converting would mean inventing a density per material. The check fails
    // and says so rather than producing a confident wrong percentage.
    const decision = matchTicket(ticket({ unit: 'cy' }), inputs());
    assert.equal(decision.status, 'PARTIAL');
    assert.match(check(decision, 'quantity')?.detail ?? '', /different units/i);
  });

  test('a PO matching no order can still find the order, but never as MATCHED', () => {
    // A misread digit should not orphan a delivery, so the search falls back to
    // supplier, date and product. But the failed PO check stays in the
    // evidence, which forces PARTIAL — so a human confirms the pairing rather
    // than the system quietly deciding a different PO was meant.
    const decision = matchTicket(ticket({ poNumber: '999999' }), inputs());
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(decision.orderId, 'order-1');
    assert.equal(check(decision, 'po')?.passed, false);
  });

  test('nothing to fall back on is UNMATCHED', () => {
    const decision = matchTicket(
      ticket({ poNumber: '999999', material: 'Limestone Screenings' }),
      inputs()
    );
    assert.equal(decision.status, 'UNMATCHED');
    assert.equal(decision.orderId, null);
  });

  test('two orders on one PO that cannot be told apart is a CONFLICT, never a guess', () => {
    // Picking one here attaches a delivery to the wrong customer's order, and
    // nothing on screen afterwards would say it had been guessed.
    const decision = matchTicket(
      ticket({ quantity: null }),
      inputs({ orders: [order({ id: 'order-1' }), order({ id: 'order-2' })] })
    );
    assert.equal(decision.status, 'CONFLICT');
    assert.equal(decision.orderId, null);
    assert.deepEqual(decision.candidateOrderIds, ['order-1', 'order-2']);
  });

  test('quantity breaks a tie when exactly one order agrees', () => {
    const decision = matchTicket(
      ticket({ quantity: 12 }),
      inputs({
        orders: [order({ id: 'order-1', quantity: 24.6 }), order({ id: 'order-2', quantity: 12 })],
      })
    );
    assert.equal(decision.status, 'MATCHED');
    assert.equal(decision.orderId, 'order-2');
  });

  test('two orders that both agree on quantity stay a CONFLICT', () => {
    const decision = matchTicket(
      ticket({ quantity: 12 }),
      inputs({
        orders: [order({ id: 'order-1', quantity: 12 }), order({ id: 'order-2', quantity: 12 })],
      })
    );
    assert.equal(decision.status, 'CONFLICT');
  });

  test('without a PO it finds the order by supplier, date and product together', () => {
    const decision = matchTicket(ticket({ poNumber: null }), inputs());
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(decision.orderId, 'order-1');
    assert.equal(check(decision, 'po')?.passed, false);
  });

  test('a different supplier is not a match, even on the same day and product', () => {
    const decision = matchTicket(
      ticket({ poNumber: null, supplierId: OTHER_SUPPLIER }),
      inputs()
    );
    assert.equal(decision.status, 'UNMATCHED');
  });

  test('a ticket dated outside the window is not matched without a PO', () => {
    const decision = matchTicket(
      ticket({ poNumber: null, ticketDate: new Date('2026-09-20T00:00:00Z') }),
      inputs()
    );
    assert.equal(decision.status, 'UNMATCHED');
  });

  test('a confirmed alias makes the supplier wording exact', () => {
    const decision = matchTicket(
      ticket({ material: '3/4 CLEAR' }),
      inputs({
        aliases: [
          { supplierId: SUPPLIER, aliasText: '3/4 CLEAR', productName: 'A Gravel 19mm' },
        ],
      })
    );
    assert.equal(decision.status, 'MATCHED');
  });

  test('an alias belonging to another supplier does not apply', () => {
    const decision = matchTicket(
      ticket({ material: '3/4 CLEAR' }),
      inputs({
        aliases: [
          { supplierId: OTHER_SUPPLIER, aliasText: '3/4 CLEAR', productName: 'A Gravel 19mm' },
        ],
      })
    );
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'product')?.passed, false);
  });

  test('unrecognised wording is reported, never stretched to fit', () => {
    // "A Gravel" and "B Gravel" score above a 0.6 similarity threshold. This
    // engine does not use one.
    const decision = matchTicket(ticket({ material: 'B Gravel 19mm' }), inputs());
    assert.equal(decision.status, 'PARTIAL');
    assert.match(check(decision, 'product')?.detail ?? '', /no confirmed alias/i);
  });

  test('a PO that is not six digits does not match by PO', () => {
    const decision = matchTicket(ticket({ poNumber: '4829' }), inputs());
    assert.equal(check(decision, 'po')?.passed, false);
    assert.match(check(decision, 'po')?.detail ?? '', /six digit/i);
  });

  test('every decision carries its evidence', () => {
    const decision = matchTicket(ticket(), inputs());
    assert.ok(decision.checks.length > 0);
    for (const entry of decision.checks) {
      assert.ok(entry.detail.length > 0, `check ${entry.name} has no detail`);
    }
    assert.ok(decision.reason.length > 0);
  });
});

describe('matchInvoiceLine', () => {
  const rates = [{ productName: 'A Gravel 19mm', rate: 18, unit: 'tonnes' }];

  /** A delivered load nobody has paid against yet. */
  const deliveredTicket = (overrides: Record<string, unknown> = {}) => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    claim: null,
    ...overrides,
  });

  /** A person's record that this load already paid a line. */
  const claim = (overrides: Record<string, unknown> = {}) => ({
    invoiceLineId: 'other-line',
    invoiceNumber: 'INV-1001',
    lineNumber: 2,
    claimedByName: 'Jane Doe',
    claimedAt: new Date('2026-09-03T00:00:00Z'),
    ...overrides,
  });

  const tickets = [deliveredTicket()];

  const lineInputs = (overrides: Partial<Parameters<typeof matchInvoiceLine>[1]> = {}) => ({
    ...inputs(),
    agreedRates: rates,
    tickets,
    competingLines: [],
    ...overrides,
  });

  test('a line backed by an order, an agreed rate and a ticket is MATCHED', () => {
    const decision = matchInvoiceLine(invoiceLine(), lineInputs());
    assert.equal(decision.status, 'MATCHED');
    assert.deepEqual(decision.ticketIds, ['ticket-1']);
  });

  test('being billed above the agreed rate is caught', () => {
    // Agreed 18.00, billed 21.40: 18.9% over.
    const decision = matchInvoiceLine(invoiceLine({ unitRate: 21.4 }), lineInputs());
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'rate')?.passed, false);
    assert.match(check(decision, 'rate')?.detail ?? '', /18\.9%/);
  });

  test('being billed for more than the tickets account for is caught', () => {
    // This is the whole product: the supplier writes the invoice, but a person
    // at the yard signs the ticket.
    const decision = matchInvoiceLine(invoiceLine({ quantity: 40 }), lineInputs());
    assert.equal(check(decision, 'ticketCoverage')?.passed, false);
    assert.match(check(decision, 'ticketCoverage')?.detail ?? '', /tickets account for 24\.6/);
  });

  test('several tickets can cover one line', () => {
    const decision = matchInvoiceLine(
      invoiceLine({ quantity: 49.2 }),
      lineInputs({
        orders: [order({ quantity: 49.2 })],
        tickets: [
          { id: 'ticket-1', poNumber: '482913', quantity: 24.6, unit: 'tonnes' },
          { id: 'ticket-2', poNumber: '482913', quantity: 24.6, unit: 'tonnes' },
        ],
      })
    );
    assert.equal(check(decision, 'ticketCoverage')?.passed, true);
    assert.equal(decision.ticketIds.length, 2);
  });

  test('tickets in an incomparable unit are not summed into a total', () => {
    // A mixed total would be confidently wrong, which is worse than no total.
    const decision = matchInvoiceLine(
      invoiceLine(),
      lineInputs({
        tickets: [{ id: 'ticket-1', poNumber: '482913', quantity: 24.6, unit: 'cy' }],
      })
    );
    assert.equal(check(decision, 'ticketCoverage')?.passed, false);
    assert.match(check(decision, 'ticketCoverage')?.detail ?? '', /comparable/i);
  });

  test('a line with no ticket at all is reported', () => {
    const decision = matchInvoiceLine(invoiceLine(), lineInputs({ tickets: [] }));
    assert.equal(check(decision, 'ticketCoverage')?.passed, false);
    assert.match(check(decision, 'ticketCoverage')?.detail ?? '', /No delivery ticket/i);
  });

  test('no agreed rate means the price is not checked, and says so', () => {
    const decision = matchInvoiceLine(invoiceLine(), lineInputs({ agreedRates: [] }));
    assert.equal(check(decision, 'rate')?.passed, false);
    assert.match(check(decision, 'rate')?.detail ?? '', /No agreed rate/i);
    assert.equal(decision.status, 'PARTIAL');
  });

  test('an agreed rate in another unit is not a discrepancy', () => {
    const decision = matchInvoiceLine(
      invoiceLine(),
      lineInputs({ agreedRates: [{ productName: 'A Gravel 19mm', rate: 18, unit: 'cy' }] })
    );
    assert.equal(check(decision, 'rate')?.passed, false);
    assert.match(check(decision, 'rate')?.detail ?? '', /not checked/i);
  });

  test('a rate inside tolerance passes', () => {
    // 18.10 against 18.00 is 0.56%, inside the 1% allowed.
    const decision = matchInvoiceLine(invoiceLine({ unitRate: 18.1 }), lineInputs());
    assert.equal(check(decision, 'rate')?.passed, true);
  });
});

describe('resolveTolerances', () => {
  test('uses the defaults when nothing is stored', () => {
    assert.deepEqual(resolveTolerances([]), DEFAULT_TOLERANCES);
  });

  test('reads stored values', () => {
    const resolved = resolveTolerances([{ key: 'match.quantityTolerancePct', value: 5 }]);
    assert.equal(resolved.quantityTolerancePct, 5);
  });

  test('a broken setting falls back rather than widening silently', () => {
    // A typo must not stop every invoice being checked, and it must not quietly
    // allow a larger discrepancy through either.
    for (const value of ['abc', -1, 500, null]) {
      const resolved = resolveTolerances([{ key: 'match.quantityTolerancePct', value }]);
      assert.equal(resolved.quantityTolerancePct, DEFAULT_TOLERANCES.quantityTolerancePct);
    }
  });
});

describe('paying the same load twice', () => {
  const rates = [{ productName: 'A Gravel 19mm', rate: 18, unit: 'tonnes' }];
  const deliveredTicket = (overrides: Record<string, unknown> = {}) => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    claim: null,
    ...overrides,
  });
  const claim = (overrides: Record<string, unknown> = {}) => ({
    invoiceLineId: 'other-line',
    invoiceNumber: 'INV-1001',
    lineNumber: 2,
    claimedByName: 'Jane Doe',
    claimedAt: new Date('2026-09-03T00:00:00Z'),
    ...overrides,
  });
  const base = (overrides: Record<string, unknown> = {}) => ({
    ...inputs(),
    agreedRates: rates,
    tickets: [deliveredTicket()],
    competingLines: [],
    ...overrides,
  });

  test('a load already used to pay another invoice cannot cover this line', () => {
    // The failure this whole feature exists to stop: before it, both lines
    // returned MATCHED and the coverage check passed on each.
    const decision = matchInvoiceLine(
      invoiceLine(),
      base({ tickets: [deliveredTicket({ claim: claim() })] })
    );

    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'ticketReuse')?.passed, false);
    assert.match(check(decision, 'ticketReuse')?.detail ?? '', /twice/);
    assert.match(check(decision, 'ticketReuse')?.detail ?? '', /INV-1001/);
    // And it is not counted towards coverage.
    assert.equal(check(decision, 'ticketCoverage')?.found, 0);
    assert.deepEqual(decision.ticketIds, []);
  });

  test("a line's own earlier claim is not a conflict with itself", () => {
    // A recompute must not fight the verdict a person already settled, or the
    // clerk learns the warning means nothing.
    const decision = matchInvoiceLine(
      invoiceLine({ id: 'line-1' }),
      base({ tickets: [deliveredTicket({ claim: claim({ invoiceLineId: 'line-1' }) })] })
    );

    assert.equal(decision.status, 'MATCHED');
    assert.equal(check(decision, 'ticketReuse')?.passed, true);
    assert.deepEqual(decision.ticketIds, ['ticket-1']);
  });

  test('a legitimate second load on the same PO still goes through', () => {
    // One ticket spent, another free and sufficient. Failing this would paint a
    // normal week yellow and breed reflex overrides.
    const decision = matchInvoiceLine(
      invoiceLine(),
      base({
        tickets: [
          deliveredTicket({ id: 'ticket-1', claim: claim() }),
          deliveredTicket({ id: 'ticket-2', ticketNumber: '88214' }),
        ],
      })
    );

    assert.equal(decision.status, 'MATCHED');
    assert.equal(check(decision, 'ticketReuse')?.passed, true);
    assert.match(check(decision, 'ticketReuse')?.detail ?? '', /not counted/);
    assert.deepEqual(decision.ticketIds, ['ticket-2']);
  });

  test('a claim by another line on the same invoice still counts as spent', () => {
    // A supplier double-listing one load on a single invoice.
    const decision = matchInvoiceLine(
      invoiceLine({ id: 'line-1' }),
      base({
        tickets: [deliveredTicket({ claim: claim({ invoiceLineId: 'line-2' }) })],
      })
    );
    assert.equal(check(decision, 'ticketReuse')?.passed, false);
  });

  test('two unreviewed invoices billing one PO both refuse to go green', () => {
    // Neither is green merely for having been matched first.
    const decision = matchInvoiceLine(
      invoiceLine({ id: 'line-1' }),
      base({
        competingLines: [
          {
            invoiceLineId: 'line-9',
            invoiceNumber: 'INV-1007',
            lineNumber: 1,
            invoiceDate: new Date('2026-09-05T00:00:00Z'),
          },
        ],
      })
    );

    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'duplicateBilling')?.passed, false);
    assert.match(check(decision, 'duplicateBilling')?.detail ?? '', /INV-1007/);
    assert.match(check(decision, 'duplicateBilling')?.detail ?? '', /repeat/);
  });

  test('a line does not compete with itself', () => {
    const decision = matchInvoiceLine(
      invoiceLine({ id: 'line-1' }),
      base({
        competingLines: [
          { invoiceLineId: 'line-1', invoiceNumber: 'INV-1', lineNumber: 1, invoiceDate: null },
        ],
      })
    );
    assert.equal(decision.status, 'MATCHED');
    assert.equal(check(decision, 'duplicateBilling'), undefined);
  });

  test('with no contention and no spent tickets the line is clean', () => {
    const decision = matchInvoiceLine(invoiceLine(), base());
    assert.equal(decision.status, 'MATCHED');
    assert.equal(check(decision, 'ticketReuse')?.passed, true);
    assert.equal(check(decision, 'duplicateBilling'), undefined);
  });
});
