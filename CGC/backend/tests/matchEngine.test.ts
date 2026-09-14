import './setupEnv.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchInvoiceLine,
  matchTicket,
  shouldAutoLink,
  shouldRemoveAutoLink,
  type CandidateOrder,
  type DeliveredTicket,
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
  const deliveredTicket = (overrides: Partial<DeliveredTicket> = {}): DeliveredTicket => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    material: 'A Gravel 19mm',
    supplierId: SUPPLIER,
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
        tickets: [deliveredTicket({ id: 'ticket-1' }), deliveredTicket({ id: 'ticket-2' })],
      })
    );
    assert.equal(check(decision, 'ticketCoverage')?.passed, true);
    assert.equal(decision.ticketIds.length, 2);
  });

  test('tickets in an incomparable unit are not summed into a total', () => {
    // A mixed total would be confidently wrong, which is worse than no total.
    const decision = matchInvoiceLine(
      invoiceLine(),
      lineInputs({ tickets: [deliveredTicket({ unit: 'cy' })] })
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
  const deliveredTicket = (overrides: Partial<DeliveredTicket> = {}): DeliveredTicket => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    material: 'A Gravel 19mm',
    supplierId: SUPPLIER,
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

/**
 * When a ticket may be attached to an order without asking anybody.
 *
 * These are written around the deploy: the rule runs against every unsettled
 * ticket in the yard within five minutes of shipping, so the case that matters
 * most is the ordinary one — a ticket whose PO names its order and whose
 * material wording nobody has aliased yet. Unlinking those would read as the
 * system breaking, and the people who had to put them back would trust the
 * next warning less.
 *
 * Linking says which delivery a load was. It commits no money: that happens
 * when somebody resolves an invoice line, which writes a TicketClaim and
 * refuses to spend a load twice.
 */
describe('automatic ticket linking', () => {
  test('a clean ticket is linked', () => {
    const decision = matchTicket(ticket(), inputs());
    assert.equal(decision.status, 'MATCHED');
    assert.equal(shouldAutoLink(decision), 'order-1');
    assert.equal(shouldRemoveAutoLink(decision), false);
  });

  test('wording nobody has aliased yet does not stop the link', () => {
    // The case this rule exists for. Tickets say "3/4 clear"; Spruce says
    // "STONE 3/4 CLEAR LIMESTONE". The PO identifies the order either way, and
    // the disagreement is shown on the desk as PARTIAL rather than acted on by
    // detaching a delivery the yard is certain about.
    const decision = matchTicket(
      ticket({ material: '3/4 clear' }),
      inputs({ orders: [order({ product: 'STONE 3/4 CLEAR LIMESTONE' })] })
    );

    assert.equal(decision.status, 'PARTIAL');
    assert.equal(check(decision, 'product')?.passed, false);
    assert.equal(shouldAutoLink(decision), 'order-1');
    assert.equal(shouldRemoveAutoLink(decision), false);
  });

  test('a short load keeps its link and argues about it on the desk', () => {
    const decision = matchTicket(ticket({ quantity: 22 }), inputs());
    assert.equal(decision.status, 'PARTIAL');
    assert.equal(shouldAutoLink(decision), 'order-1');
  });

  test('a load dated outside the window keeps its link too', () => {
    const decision = matchTicket(
      ticket({ ticketDate: new Date('2026-09-20T00:00:00Z') }),
      inputs()
    );
    assert.equal(check(decision, 'date')?.passed, false);
    assert.equal(shouldAutoLink(decision), 'order-1');
  });

  test('an order found only by supplier, date and product is never linked', () => {
    // A plausible pairing is not an identification. Without the PO the only
    // evidence is that somebody sold this product around this date, which fits
    // every other customer's load of the same material that week.
    const decision = matchTicket(ticket({ poNumber: null }), inputs());

    assert.equal(decision.status, 'PARTIAL');
    assert.equal(decision.orderId, 'order-1');
    assert.equal(check(decision, 'po')?.passed, false);
    assert.equal(shouldAutoLink(decision), null);
    // Nor is an existing link taken away: the order is still the likely one.
    assert.equal(shouldRemoveAutoLink(decision), false);
  });

  test('a misread PO that falls back to supplier and date is not linked', () => {
    const decision = matchTicket(ticket({ poNumber: '999999' }), inputs());
    assert.equal(decision.orderId, 'order-1');
    assert.equal(shouldAutoLink(decision), null);
    assert.equal(shouldRemoveAutoLink(decision), false);
  });

  test('two orders on one PO unlink, because neither can be identified', () => {
    const decision = matchTicket(
      ticket({ quantity: null }),
      inputs({ orders: [order({ id: 'order-1' }), order({ id: 'order-2' })] })
    );

    assert.equal(decision.status, 'CONFLICT');
    assert.equal(shouldAutoLink(decision), null);
    assert.equal(shouldRemoveAutoLink(decision), true);
  });

  test('nothing on file at all unlinks', () => {
    const decision = matchTicket(
      ticket({ poNumber: '999999', material: 'Limestone Screenings' }),
      inputs()
    );

    assert.equal(decision.status, 'UNMATCHED');
    assert.equal(shouldAutoLink(decision), null);
    assert.equal(shouldRemoveAutoLink(decision), true);
  });

  test('the PO now naming a different order relinks to that one', () => {
    const decision = matchTicket(
      ticket({ quantity: 12 }),
      inputs({
        orders: [order({ id: 'order-1', quantity: 24.6 }), order({ id: 'order-2', quantity: 12 })],
      })
    );
    assert.equal(shouldAutoLink(decision), 'order-2');
  });
});

/**
 * One PO, two products.
 *
 * Cambridge orders gravel and sand on the same purchase order all the time, and
 * the supplier bills them as two lines. Before this, each line summed every
 * ticket on the PO: both lines failed coverage against a total neither of them
 * was, or both passed against a total that covered the pair. Worse, confirming
 * the first line claimed the second product's loads too, and the second line
 * then read "every ticket on this PO has already been used".
 */
describe('two products on one PO', () => {
  const GRAVEL = 'A Gravel 19mm';
  const SAND = 'Concrete Sand';

  const rates = [
    { productName: GRAVEL, rate: 18, unit: 'tonnes' },
    { productName: SAND, rate: 22, unit: 'tonnes' },
  ];

  const load = (overrides: Partial<DeliveredTicket> = {}): DeliveredTicket => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    material: GRAVEL,
    supplierId: SUPPLIER,
    claim: null,
    ...overrides,
  });

  const gravelLoad = load({ id: 'gravel-load', ticketNumber: '88213' });
  const sandLoad = load({ id: 'sand-load', ticketNumber: '88214', material: SAND, quantity: 18 });

  const orders = [
    order({ id: 'order-gravel', product: GRAVEL, quantity: 24.6 }),
    order({ id: 'order-sand', product: SAND, quantity: 18 }),
  ];

  const lineInputs = (tickets: DeliveredTicket[]) => ({
    ...inputs({ orders }),
    agreedRates: rates,
    tickets,
    competingLines: [],
  });

  test('each line counts only the loads of its own product', () => {
    const gravel = matchInvoiceLine(
      invoiceLine({ id: 'line-gravel', description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([gravelLoad, sandLoad])
    );
    const sand = matchInvoiceLine(
      invoiceLine({ id: 'line-sand', description: SAND, quantity: 18, unitRate: 22 }),
      lineInputs([gravelLoad, sandLoad])
    );

    assert.equal(check(gravel, 'ticketCoverage')?.passed, true);
    assert.equal(check(gravel, 'ticketCoverage')?.found, 24.6);
    assert.equal(check(sand, 'ticketCoverage')?.passed, true);
    assert.equal(check(sand, 'ticketCoverage')?.found, 18);
  });

  test('a line claims exactly the loads it counted, never the other product', () => {
    // The bug this replaces: confirming the gravel line spent the sand load as
    // well, and the sand line was then told its own delivery had been used up.
    const gravel = matchInvoiceLine(
      invoiceLine({ id: 'line-gravel', description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([gravelLoad, sandLoad])
    );
    assert.deepEqual(gravel.ticketIds, ['gravel-load']);
  });

  test('the other product is named rather than quietly dropped', () => {
    const gravel = matchInvoiceLine(
      invoiceLine({ id: 'line-gravel', description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([gravelLoad, sandLoad])
    );
    assert.match(
      check(gravel, 'ticketCoverage')?.detail ?? '',
      /1 ticket on this PO carries a different product/i
    );
  });

  test('a load whose material could not be read still counts, and says so', () => {
    // An unreadable ticket is an OCR problem, not an absent delivery. Excluding
    // it would report "billed 24.6 but tickets account for 0" over a load that
    // is sitting in the yard.
    const decision = matchInvoiceLine(
      invoiceLine({ description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([load({ id: 'unreadable', material: null })])
    );

    assert.equal(check(decision, 'ticketCoverage')?.passed, true);
    assert.deepEqual(decision.ticketIds, ['unreadable']);
    assert.match(
      check(decision, 'ticketCoverage')?.detail ?? '',
      /does not say what it was carrying/i
    );
  });

  test('a load in an incomparable unit is not claimed by the line it could not cover', () => {
    // It was counted as "available" before, so a resolution spent it — a load
    // measured in cubic yards paid for a line billed in tonnes, invisibly.
    const decision = matchInvoiceLine(
      invoiceLine({ description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([load({ id: 'in-yards', unit: 'cy' })])
    );

    assert.equal(check(decision, 'ticketCoverage')?.passed, false);
    assert.deepEqual(decision.ticketIds, []);
  });

  test('a ticket on this PO from another supplier is excluded and reported', () => {
    const decision = matchInvoiceLine(
      invoiceLine({ description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([load({ id: 'someone-else', supplierId: OTHER_SUPPLIER })])
    );

    assert.equal(check(decision, 'ticketCoverage')?.passed, false);
    assert.deepEqual(decision.ticketIds, []);
    assert.match(
      check(decision, 'ticketCoverage')?.detail ?? '',
      /belongs to another supplier/i
    );
  });

  test('a ticket whose supplier could not be read is counted, and said so', () => {
    // Dropping it reported "no delivery ticket accounts for this line" over a
    // load that had plainly arrived — an OCR miss presented as a missing truck.
    const decision = matchInvoiceLine(
      invoiceLine({ description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([load({ id: 'no-supplier', supplierId: null })])
    );

    assert.equal(check(decision, 'ticketCoverage')?.passed, true);
    assert.deepEqual(decision.ticketIds, ['no-supplier']);
    assert.match(check(decision, 'ticketCoverage')?.detail ?? '', /does not name a supplier/i);
  });

  test('a confirmed alias makes a supplier wording count for the right line', () => {
    const decision = matchInvoiceLine(
      invoiceLine({ description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      {
        ...lineInputs([load({ id: 'aliased', material: '3/4 CLEAR' })]),
        aliases: [{ supplierId: SUPPLIER, aliasText: '3/4 CLEAR', productName: GRAVEL }],
      }
    );

    assert.equal(check(decision, 'ticketCoverage')?.passed, true);
    assert.deepEqual(decision.ticketIds, ['aliased']);
  });

  test('a reuse warning on the other product does not land on this line', () => {
    // The sand load being spent says nothing about the gravel line, and a
    // warning that is usually irrelevant is one people learn to click through.
    const decision = matchInvoiceLine(
      invoiceLine({ id: 'line-gravel', description: GRAVEL, quantity: 24.6, unitRate: 18 }),
      lineInputs([
        gravelLoad,
        load({
          id: 'sand-load',
          material: SAND,
          claim: {
            invoiceLineId: 'some-other-line',
            invoiceNumber: 'INV-1001',
            lineNumber: 2,
            claimedByName: 'Jane Doe',
            claimedAt: new Date('2026-09-03T00:00:00Z'),
          },
        }),
      ])
    );

    assert.equal(check(decision, 'ticketReuse')?.passed, true);
    assert.equal(check(decision, 'ticketReuse')?.detail, 'No ticket on this line has been used to pay another invoice.');
  });
});

/**
 * Numbers a person has to read.
 *
 * A percentage against zero is Infinity, and "Infinity%" on the verification
 * desk reads as a broken system rather than as the data problem it is.
 */
describe('differences against zero', () => {
  const load = (overrides: Partial<DeliveredTicket> = {}): DeliveredTicket => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    material: 'A Gravel 19mm',
    supplierId: SUPPLIER,
    claim: null,
    ...overrides,
  });

  test('an order recorded at zero is explained, not printed as Infinity%', () => {
    const decision = matchTicket(ticket(), inputs({ orders: [order({ quantity: 0 })] }));
    const quantity = check(decision, 'quantity');

    assert.equal(quantity?.passed, false);
    assert.doesNotMatch(quantity?.detail ?? '', /Infinity/);
    assert.match(quantity?.detail ?? '', /quantity of 0/i);
  });

  test('an agreed rate of zero is explained, not printed as Infinity%', () => {
    const decision = matchInvoiceLine(invoiceLine(), {
      ...inputs(),
      agreedRates: [{ productName: 'A Gravel 19mm', rate: 0, unit: 'tonnes' }],
      tickets: [load()],
      competingLines: [],
    });
    const rate = check(decision, 'rate');

    assert.equal(rate?.passed, false);
    assert.doesNotMatch(rate?.detail ?? '', /Infinity/);
  });

  test('a line billing zero is explained, not printed as Infinity%', () => {
    const decision = matchInvoiceLine(invoiceLine({ quantity: 0 }), {
      ...inputs(),
      agreedRates: [{ productName: 'A Gravel 19mm', rate: 18, unit: 'tonnes' }],
      tickets: [load()],
      competingLines: [],
    });
    const coverage = check(decision, 'ticketCoverage');

    assert.equal(coverage?.passed, false);
    assert.doesNotMatch(coverage?.detail ?? '', /Infinity/);
  });
});

/**
 * The agreed rate chosen when a product is priced more than once.
 *
 * Taking whichever row came back first measured a line billed per tonne against
 * a price agreed per skid, and reported the result as a several-hundred-percent
 * overcharge that nobody had committed.
 */
describe('choosing between agreed rates', () => {
  const load = (): DeliveredTicket => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    material: 'A Gravel 19mm',
    supplierId: SUPPLIER,
    claim: null,
  });

  test('the rate in a unit the line can be compared against is preferred', () => {
    const decision = matchInvoiceLine(invoiceLine({ unitRate: 18 }), {
      ...inputs(),
      agreedRates: [
        { productName: 'A Gravel 19mm', rate: 260, unit: 'skid' },
        { productName: 'A Gravel 19mm', rate: 18, unit: 'tonnes' },
      ],
      tickets: [load()],
      competingLines: [],
    });

    assert.equal(check(decision, 'rate')?.passed, true);
    assert.equal(check(decision, 'rate')?.expected, 18);
    assert.equal(decision.totals?.agreedRate, 18);
  });

  test('with no comparable unit the rate is still named, and not applied', () => {
    const decision = matchInvoiceLine(invoiceLine({ unitRate: 18 }), {
      ...inputs(),
      agreedRates: [{ productName: 'A Gravel 19mm', rate: 260, unit: 'skid' }],
      tickets: [load()],
      competingLines: [],
    });

    assert.equal(check(decision, 'rate')?.passed, false);
    assert.match(check(decision, 'rate')?.detail ?? '', /not checked/);
    assert.equal(decision.totals?.agreedRate, null);
    assert.equal(decision.totals?.rateUnitMismatch, true);
  });
});

/**
 * The numbers the invoice screens store on the line itself.
 *
 * They used to be computed a second time, by a looser comparison, so the line
 * and the verdict beside it could disagree. They are a projection of the
 * verdict now, and these tests pin the direction of each sign: positive means
 * "billed more than agreed" and "billed more than arrived".
 */
describe('what the line columns are derived from', () => {
  const load = (overrides: Partial<DeliveredTicket> = {}): DeliveredTicket => ({
    id: 'ticket-1',
    ticketNumber: '88213',
    poNumber: '482913',
    quantity: 24.6,
    unit: 'tonnes',
    material: 'A Gravel 19mm',
    supplierId: SUPPLIER,
    claim: null,
    ...overrides,
  });

  const lineInputs = (overrides: Record<string, unknown> = {}) => ({
    ...inputs(),
    agreedRates: [{ productName: 'A Gravel 19mm', rate: 18, unit: 'tonnes' }],
    tickets: [load()],
    competingLines: [],
    ...overrides,
  });

  test('a clean line carries no discrepancy at all', () => {
    const decision = matchInvoiceLine(invoiceLine(), lineInputs());
    assert.deepEqual(decision.totals, {
      agreedRate: 18,
      rateDiscrepancy: null,
      quantityDiscrepancy: null,
      rateUnitMismatch: false,
    });
  });

  test('being over-billed on rate is positive', () => {
    const decision = matchInvoiceLine(invoiceLine({ unitRate: 21.4 }), lineInputs());
    assert.equal(decision.totals?.rateDiscrepancy, 3.4);
  });

  test('being under-billed on rate is negative, and still recorded', () => {
    // It usually means the wrong rate or the wrong product, and the correction
    // tends to arrive later.
    const decision = matchInvoiceLine(invoiceLine({ unitRate: 15 }), lineInputs());
    assert.equal(decision.totals?.rateDiscrepancy, -3);
  });

  test('being billed for more than arrived is positive', () => {
    const decision = matchInvoiceLine(
      invoiceLine({ quantity: 40 }),
      lineInputs({ orders: [order({ quantity: 40 })] })
    );
    assert.equal(decision.totals?.quantityDiscrepancy, 15.4);
  });

  test('a difference inside tolerance is not a discrepancy', () => {
    const decision = matchInvoiceLine(invoiceLine({ quantity: 24.9 }), lineInputs());
    assert.equal(decision.totals?.quantityDiscrepancy, null);
  });

  test('a ticket verdict carries no line columns', () => {
    assert.equal(matchTicket(ticket(), inputs()).totals, null);
  });
});
