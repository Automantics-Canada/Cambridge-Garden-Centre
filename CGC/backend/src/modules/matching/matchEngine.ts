import { compareUnits } from '../../lib/units.js';
import { normalizeProductName } from '../../lib/productName.js';
import type { Tolerances } from './tolerances.js';

/**
 * Deciding whether a delivery ticket, or a line on a supplier invoice, is
 * backed by something CGC actually ordered and received.
 *
 * This is the question the whole product exists to answer: should we pay this?
 * A wrong "yes" pays a supplier for material that never arrived, so the rule
 * throughout is that certainty has to be earned. Where it cannot be, the answer
 * is not a best guess — it is PARTIAL or CONFLICT, and a person is asked.
 *
 * The module is pure on purpose. It takes rows and returns a decision; it reads
 * nothing and writes nothing. That is what makes every branch below testable
 * without a database, and it is the same shape as reconcileSpruceDocument.ts,
 * which aborts a whole document rather than resolve an ambiguity by picking.
 *
 * Two deliberate absences:
 *
 *   - **No fuzzy product matching.** The invoice service compares product
 *     wording with a similarity score, where 0.6 or a substring hit counts as
 *     the same product. "A Gravel" and "B Gravel" score above that. A confirmed
 *     alias is exact; anything else is reported as unrecognised rather than
 *     assumed.
 *   - **No unit conversion.** Tonnes are not converted to cubic yards, because
 *     that needs a density per material that nobody here has agreed. An
 *     incomparable pair of units is a failed check, not a converted one.
 */

export type MatchStatus = 'MATCHED' | 'PARTIAL' | 'UNMATCHED' | 'CONFLICT';

/** One thing that was checked, and what it found. Written for a person to read. */
export interface MatchCheck {
  name:
    | 'po'
    | 'supplier'
    | 'date'
    | 'product'
    | 'quantity'
    | 'rate'
    | 'ticketCoverage'
    | 'ticketReuse'
    | 'duplicateBilling';
  passed: boolean;
  /** A sentence naming what was compared and what came back. */
  detail: string;
  expected?: string | number | null;
  found?: string | number | null;
  /** Signed difference where both sides were numbers and comparable. */
  delta?: number;
}

export interface MatchDecision {
  status: MatchStatus;
  /** The order this was matched to, when exactly one survived. */
  orderId: string | null;
  /** Tickets that account for an invoice line's quantity. */
  ticketIds: string[];
  /** Every order still plausible when the status is CONFLICT. */
  candidateOrderIds: string[];
  /** The evidence. A status is never shown without it. */
  checks: MatchCheck[];
  /** One line explaining the status, for the desk and the audit log. */
  reason: string;
  /** Set for an invoice line, null for a ticket, which has no such columns. */
  totals: LineTotals | null;
}

export interface CandidateOrder {
  id: string;
  poNumber: string | null;
  product: string;
  quantity: number | null;
  unit: string | null;
  supplierId: string | null;
  orderDate: Date;
}

export interface TicketSubject {
  id: string;
  poNumber: string | null;
  material: string | null;
  quantity: number | null;
  unit: string | null;
  supplierId: string | null;
  ticketDate: Date | null;
}

export interface InvoiceLineSubject {
  id: string;
  poNumber: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitRate: number | null;
  supplierId: string | null;
  invoiceDate: Date | null;
}

/**
 * A person's record that this ticket has been used to justify paying one
 * specific invoice line. Only a resolution creates one; the engine never does.
 */
export interface TicketClaimRef {
  invoiceLineId: string;
  invoiceNumber: string;
  lineNumber: number;
  claimedByName: string | null;
  claimedAt: Date;
}

/** A ticket already accepted as evidence, used to cover an invoice line. */
export interface DeliveredTicket {
  id: string;
  /** For wording only, so a person can find the paper. */
  ticketNumber: string | null;
  poNumber: string | null;
  quantity: number | null;
  unit: string | null;
  /**
   * What the load was, as written on the ticket.
   *
   * A PO routinely carries two products — gravel on one line, sand on the next
   * — and before this was here every line on that PO summed every ticket on it.
   * Both lines then failed coverage, or both passed on a total neither of them
   * had earned.
   */
  material: string | null;
  /**
   * Who delivered it, where the ticket says so.
   *
   * Null is common and must not be fatal: when OCR cannot read the supplier,
   * the load still happened. A ticket from a *different* supplier on the same
   * PO is a different matter and is excluded.
   */
  supplierId: string | null;
  /** Set when somebody has already paid a line against this load. */
  claim: TicketClaimRef | null;
}

/**
 * The few conclusions the invoice line row stores as columns of its own.
 *
 * The invoice screens read `negotiatedRate`, `rateDiscrepancy` and
 * `qtyDiscrepancy` off the line itself rather than off the evidence. Those
 * columns used to be computed a second time, by a second comparison with a
 * different idea of what counts as the same product — so the line said one
 * thing and the verdict beside it said another. They are derived from this
 * instead, which means there is one comparison and it is the one shown.
 */
export interface LineTotals {
  /** The agreed rate actually compared against, or null when none could be. */
  agreedRate: number | null;
  /** Signed difference from the agreed rate, only when beyond tolerance. */
  rateDiscrepancy: number | null;
  /**
   * How much more was billed than the tickets account for, only when beyond
   * tolerance. Positive means over-billed, which is the direction the screens
   * word it in.
   */
  quantityDiscrepancy: number | null;
  /**
   * An agreed rate exists for this product but is priced per a unit the line
   * cannot be compared against. A different problem from having no rate at
   * all — it is fixed by correcting a unit, not by adding a rate — and the
   * line's flag distinguishes the two.
   */
  rateUnitMismatch: boolean;
}

/**
 * Another invoice line billing the same PO that nobody has ruled on yet.
 *
 * Contention is derived rather than stored: both lines see each other, so
 * neither goes green merely for being matched first.
 */
export interface CompetingLine {
  invoiceLineId: string;
  invoiceNumber: string;
  lineNumber: number;
  invoiceDate: Date | null;
}

/** A rate a person entered and confirmed. */
export interface AgreedRate {
  productName: string;
  rate: number;
  unit: string;
}

/** A confirmed mapping from a supplier's wording to a CGC product. */
export interface ProductAlias {
  supplierId: string;
  aliasText: string;
  productName: string;
}

export interface MatchInputs {
  orders: ReadonlyArray<CandidateOrder>;
  aliases: ReadonlyArray<ProductAlias>;
  tolerances: Tolerances;
}

const PO_PATTERN = /^\d{6}$/;

/** Resolves a supplier's wording to a CGC product name, or null if unmapped. */
function resolveProduct(
  supplierId: string | null,
  text: string | null,
  aliases: ReadonlyArray<ProductAlias>
): string | null {
  if (!text) return null;
  const normalised = normalizeProductName(text);
  if (!normalised) return null;

  if (supplierId) {
    const alias = aliases.find(
      (entry) =>
        entry.supplierId === supplierId && normalizeProductName(entry.aliasText) === normalised
    );
    if (alias) return normalizeProductName(alias.productName);
  }

  // No alias on file. The wording is still usable if it already matches the
  // order's own wording exactly; it is never stretched to fit.
  return normalised;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Difference as a percentage of what was expected, or Infinity against zero.
 *
 * Infinity is the honest answer — nothing is a meaningful percentage of zero —
 * but it must never reach a person's screen as "Infinity%", which reads as a
 * broken system rather than as the data problem it actually is. Every caller
 * checks `Number.isFinite` and says what happened in words instead.
 */
function percentDifference(expected: number, found: number): number {
  if (expected === 0) return found === 0 ? 0 : Infinity;
  return Math.abs((found - expected) / expected) * 100;
}

/**
 * Whether a difference is inside tolerance.
 *
 * The epsilon is for binary floating point, not for generosity: 24.6 x 1.02
 * evaluates to 2.0000000000000018 percent, and rejecting a load for the
 * eighteenth decimal place would be indefensible to the person reading it.
 */
function withinTolerance(differencePct: number, tolerancePct: number): boolean {
  return differencePct <= tolerancePct + 1e-9;
}

/**
 * Compares two quantities, refusing to compare across units.
 *
 * A load recorded in tonnes and an order written in cubic yards are not a 10%
 * discrepancy, they are two different measurements. Saying so is the point.
 */
function checkQuantity(
  orderedQuantity: number | null,
  orderedUnit: string | null,
  deliveredQuantity: number | null,
  deliveredUnit: string | null,
  tolerancePct: number
): MatchCheck {
  if (orderedQuantity === null || deliveredQuantity === null) {
    return {
      name: 'quantity',
      passed: false,
      detail:
        orderedQuantity === null
          ? 'The order does not record a quantity, so nothing could be compared'
          : 'No quantity could be read from the document',
      expected: orderedQuantity,
      found: deliveredQuantity,
    };
  }

  const units = compareUnits(deliveredUnit, orderedUnit);
  if (!units.comparable) {
    return {
      name: 'quantity',
      passed: false,
      detail:
        units.reason === 'DIFFERENT'
          ? `Quantities are in different units (${units.invoiceUnit} against ${units.rateUnit}), so they were not compared`
          : `A unit could not be recognised (document "${units.invoiceUnit ?? 'none'}", order "${units.rateUnit ?? 'none'}"), so quantities were not compared`,
      expected: orderedQuantity,
      found: deliveredQuantity,
    };
  }

  const difference = percentDifference(orderedQuantity, deliveredQuantity);
  const passed = withinTolerance(difference, tolerancePct);
  return {
    name: 'quantity',
    passed,
    detail: passed
      ? `Quantity is within ${tolerancePct}% of the order`
      : Number.isFinite(difference)
        ? `Quantity differs from the order by ${difference.toFixed(1)}%, beyond the ${tolerancePct}% allowed`
        : `The order records a quantity of 0, so the delivered ${deliveredQuantity} cannot be expressed as a percentage of it`,
    expected: orderedQuantity,
    found: deliveredQuantity,
    delta: Number((deliveredQuantity - orderedQuantity).toFixed(4)),
  };
}

/** Narrows candidate orders and records how it was done. */
function findCandidates(
  subject: { poNumber: string | null; supplierId: string | null; date: Date | null },
  productName: string | null,
  inputs: MatchInputs
): { candidates: CandidateOrder[]; checks: MatchCheck[] } {
  const checks: MatchCheck[] = [];
  const po = subject.poNumber;

  if (po && PO_PATTERN.test(po)) {
    const byPo = inputs.orders.filter((order) => order.poNumber === po);
    checks.push({
      name: 'po',
      passed: byPo.length > 0,
      detail:
        byPo.length > 0
          ? `PO ${po} matches ${byPo.length} order line${byPo.length === 1 ? '' : 's'}`
          : `PO ${po} matches no order`,
      found: po,
    });
    if (byPo.length > 0) return { candidates: byPo, checks };
  } else {
    checks.push({
      name: 'po',
      passed: false,
      detail: po
        ? `"${po}" is not a six digit purchase order number`
        : 'No purchase order number was read from the document',
      found: po,
    });
  }

  // Fall back to supplier, date and product together. Any one of them alone
  // would match far too much to be evidence of anything.
  if (!subject.supplierId || !subject.date || !productName) {
    checks.push({
      name: 'supplier',
      passed: false,
      detail:
        'Without a PO, an order can only be found by supplier, date and product together, and at least one of those is missing',
    });
    return { candidates: [], checks };
  }

  const window = inputs.tolerances.dateWindowDays;
  const candidates = inputs.orders.filter((order) => {
    if (order.supplierId !== subject.supplierId) return false;
    if (daysBetween(order.orderDate, subject.date as Date) > window) return false;
    return normalizeProductName(order.product) === productName;
  });

  checks.push({
    name: 'supplier',
    passed: candidates.length > 0,
    detail:
      candidates.length > 0
        ? `Found ${candidates.length} order line${candidates.length === 1 ? '' : 's'} from this supplier within ${window} days carrying the same product`
        : `No order from this supplier within ${window} days carries this product`,
  });

  return { candidates, checks };
}

/**
 * Chooses between several surviving orders, or refuses to.
 *
 * Quantity is the only tie-breaker allowed. If exactly one candidate agrees on
 * quantity it is the match; if several do, or none do, the choice would be
 * arbitrary — and an arbitrary choice here attaches a delivery to the wrong
 * customer's order, which is invisible afterwards.
 */
function disambiguate(
  candidates: CandidateOrder[],
  deliveredQuantity: number | null,
  deliveredUnit: string | null,
  tolerancePct: number
): CandidateOrder | null {
  if (candidates.length === 1) return candidates[0] as CandidateOrder;
  if (deliveredQuantity === null) return null;

  const agreeing = candidates.filter((order) => {
    const check = checkQuantity(
      order.quantity,
      order.unit,
      deliveredQuantity,
      deliveredUnit,
      tolerancePct
    );
    return check.passed;
  });

  return agreeing.length === 1 ? (agreeing[0] as CandidateOrder) : null;
}

/**
 * The order an automatic ticket link may point at, or null to leave it alone.
 *
 * Attaching a ticket to an order answers "which delivery is this". It is an
 * operational fact, not a payment: money is committed by resolving an invoice
 * line, which has its own gates and writes a TicketClaim. So this asks less
 * than MATCHED does, on purpose.
 *
 * What it asks is that the order was identified *by its purchase order number*.
 * A six digit PO naming exactly one order line is the identity evidence — it is
 * what the yard wrote on the paper — and the engine only ever reaches an
 * orderId through the PO or through the supplier/date/product fallback.
 *
 * Requiring MATCHED here was wrong and would have unlinked most of the yard's
 * tickets on sight. MATCHED additionally wants the ticket's material wording to
 * equal the order's exactly: a ticket reading "3/4 clear" against a Spruce line
 * reading "STONE 3/4 CLEAR LIMESTONE" is PARTIAL until somebody records the
 * alias, and almost none are recorded yet. That discrepancy still has to be
 * seen — and it is, as PARTIAL on the verification desk, with the failing check
 * spelled out beside it. It is not a reason to detach a delivery everybody at
 * the yard knows the destination of.
 *
 * The fallback route is excluded: an order found only by supplier, date and
 * product is a plausible pairing, not an identification, and pairing one of
 * those automatically is the guess this engine exists not to make.
 */
export function shouldAutoLink(decision: MatchDecision): string | null {
  if (!decision.orderId) return null;
  const po = decision.checks.find((check) => check.name === 'po');
  return po?.passed === true ? decision.orderId : null;
}

/**
 * Whether an existing automatic link should be taken away.
 *
 * Only when nothing is identifiable any more: CONFLICT means several orders now
 * fit the same PO, UNMATCHED means none does. Both make the stored link a claim
 * the engine can no longer support, and a link the ticket list shows as settled
 * while the desk shows a problem is worse than no link.
 *
 * A PARTIAL is deliberately not grounds for removal. The order is still
 * identified; something about it disagrees, which is what the evidence is for.
 */
export function shouldRemoveAutoLink(decision: MatchDecision): boolean {
  if (shouldAutoLink(decision) !== null) return false;
  return decision.status === 'CONFLICT' || decision.status === 'UNMATCHED';
}

function decide(
  order: CandidateOrder | null,
  candidates: CandidateOrder[],
  checks: MatchCheck[],
  subjectLabel: string
): Pick<MatchDecision, 'status' | 'orderId' | 'candidateOrderIds' | 'reason'> {
  if (!order) {
    if (candidates.length > 1) {
      return {
        status: 'CONFLICT',
        orderId: null,
        candidateOrderIds: candidates.map((candidate) => candidate.id),
        reason: `${candidates.length} orders fit this ${subjectLabel} equally well; a person must choose`,
      };
    }
    return {
      status: 'UNMATCHED',
      orderId: null,
      candidateOrderIds: [],
      reason: `No order could be found for this ${subjectLabel}`,
    };
  }

  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) {
    return {
      status: 'MATCHED',
      orderId: order.id,
      candidateOrderIds: [],
      reason: 'Every check passed',
    };
  }

  return {
    status: 'PARTIAL',
    orderId: order.id,
    candidateOrderIds: [],
    reason: failed.map((check) => check.detail).join('; '),
  };
}

/** Is this delivery ticket backed by an order? */
export function matchTicket(ticket: TicketSubject, inputs: MatchInputs): MatchDecision {
  const productName = resolveProduct(ticket.supplierId, ticket.material, inputs.aliases);

  const { candidates, checks } = findCandidates(
    { poNumber: ticket.poNumber, supplierId: ticket.supplierId, date: ticket.ticketDate },
    productName,
    inputs
  );

  const order = disambiguate(
    candidates,
    ticket.quantity,
    ticket.unit,
    inputs.tolerances.quantityTolerancePct
  );

  if (order) {
    const orderProduct = normalizeProductName(order.product);
    checks.push({
      name: 'product',
      passed: productName !== null && productName === orderProduct,
      detail:
        productName === null
          ? 'No material was read from the ticket'
          : productName === orderProduct
            ? 'Material matches the order'
            : `Ticket says "${ticket.material}", the order says "${order.product}", and no confirmed alias links them`,
      expected: order.product,
      found: ticket.material,
    });

    checks.push(
      checkQuantity(
        order.quantity,
        order.unit,
        ticket.quantity,
        ticket.unit,
        inputs.tolerances.quantityTolerancePct
      )
    );

    if (ticket.ticketDate) {
      const days = daysBetween(order.orderDate, ticket.ticketDate);
      checks.push({
        name: 'date',
        passed: days <= inputs.tolerances.dateWindowDays,
        detail:
          days <= inputs.tolerances.dateWindowDays
            ? `Ticket is dated within ${inputs.tolerances.dateWindowDays} days of the order`
            : `Ticket is dated ${Math.round(days)} days from the order, outside the ${inputs.tolerances.dateWindowDays} day window`,
        delta: Math.round(days),
      });
    }
  }

  return { ...decide(order, candidates, checks, 'ticket'), ticketIds: [], checks, totals: null };
}

/**
 * Is this invoice line backed by an order, an agreed rate, and tickets?
 *
 * The rate check is what catches being billed above what was negotiated. The
 * coverage check is what catches being billed for material no ticket accounts
 * for — the supplier writes the invoice, but a person at the yard signs the
 * ticket, so tickets are the only independent record of what actually moved.
 */
export function matchInvoiceLine(
  line: InvoiceLineSubject,
  inputs: MatchInputs & {
    tickets: ReadonlyArray<DeliveredTicket>;
    agreedRates: ReadonlyArray<AgreedRate>;
    /** Other unreviewed lines billing this PO. Empty is the normal case. */
    competingLines: ReadonlyArray<CompetingLine>;
  }
): MatchDecision {
  const productName = resolveProduct(line.supplierId, line.description, inputs.aliases);

  const { candidates, checks } = findCandidates(
    { poNumber: line.poNumber, supplierId: line.supplierId, date: line.invoiceDate },
    productName,
    inputs
  );

  const order = disambiguate(
    candidates,
    line.quantity,
    line.unit,
    inputs.tolerances.quantityTolerancePct
  );

  if (order) {
    const orderProduct = normalizeProductName(order.product);
    checks.push({
      name: 'product',
      passed: productName !== null && productName === orderProduct,
      detail:
        productName === null
          ? 'No product could be read from the invoice line'
          : productName === orderProduct
            ? 'Product matches the order'
            : `Invoice says "${line.description}", the order says "${order.product}", and no confirmed alias links them`,
      expected: order.product,
      found: line.description,
    });
  }

  // Rate. An agreed rate in a different unit is not a discrepancy, it is a
  // comparison that cannot be made.
  //
  // A product is sometimes priced twice — per tonne for bulk and per skid for
  // bagged — and taking whichever row came back first meant a line billed per
  // tonne could be measured against a per-skid price and reported as a 400%
  // overcharge. The rate that can actually be compared is preferred; if none
  // can, the first is still reported, so the evidence names a real agreed
  // price rather than saying nothing is on file.
  const forProduct = productName
    ? inputs.agreedRates.filter(
        (rate) => normalizeProductName(rate.productName) === productName
      )
    : [];
  const agreed =
    forProduct.find((rate) => compareUnits(line.unit, rate.unit).comparable) ?? forProduct[0];

  /** Filled in as the checks below run; see LineTotals for why it exists. */
  const totals: LineTotals = {
    agreedRate: null,
    rateDiscrepancy: null,
    quantityDiscrepancy: null,
    rateUnitMismatch: false,
  };

  if (!agreed) {
    checks.push({
      name: 'rate',
      passed: false,
      detail: 'No agreed rate is on file for this product, so the price was not checked',
      found: line.unitRate,
    });
  } else if (line.unitRate === null) {
    checks.push({
      name: 'rate',
      passed: false,
      detail: 'No rate could be read from the invoice line',
      expected: agreed.rate,
    });
  } else {
    const units = compareUnits(line.unit, agreed.unit);
    if (!units.comparable) {
      // Recorded distinctly from "no rate on file": this one is resolved by
      // correcting a unit, not by agreeing a price.
      totals.rateUnitMismatch = true;
      checks.push({
        name: 'rate',
        passed: false,
        detail: `The agreed rate is per ${agreed.unit} and the line is billed per ${line.unit ?? 'an unrecorded unit'}, so the price was not checked`,
        expected: agreed.rate,
        found: line.unitRate,
      });
    } else {
      const difference = percentDifference(agreed.rate, line.unitRate);
      const passed = withinTolerance(difference, inputs.tolerances.priceTolerancePct);
      const delta = Number((line.unitRate - agreed.rate).toFixed(4));

      totals.agreedRate = agreed.rate;
      if (!passed) totals.rateDiscrepancy = delta;

      checks.push({
        name: 'rate',
        passed,
        detail: passed
          ? 'Billed rate matches the agreed rate'
          : Number.isFinite(difference)
            ? `Billed at ${line.unitRate} against an agreed ${agreed.rate} per ${agreed.unit}, ${difference.toFixed(1)}% above the ${inputs.tolerances.priceTolerancePct}% allowed`
            : `Billed at ${line.unitRate} against an agreed rate of 0 per ${agreed.unit}, which cannot be expressed as a percentage`,
        expected: agreed.rate,
        found: line.unitRate,
        delta,
      });
    }
  }

  // Ticket coverage. One invoice line can cover several truckloads, so the
  // tickets are summed — but only those recorded in a unit the line can be
  // compared against, because a mixed total would be confidently wrong.
  //
  // Narrowing from "every ticket on the PO" to "every ticket on the PO that is
  // this line's product, from this supplier" is what stops a two-product PO
  // grading both of its invoice lines against one combined total. The
  // exclusions are named in the detail rather than applied silently: a load
  // that was left out is exactly the thing a person needs told about.
  const onPo =
    line.poNumber === null
      ? []
      : inputs.tickets.filter((ticket) => ticket.poNumber === line.poNumber);

  // A ticket whose supplier is plainly somebody else is not evidence for this
  // invoice. A ticket with no readable supplier still is: the load happened,
  // and dropping it would report "no delivery ticket" over an OCR miss.
  const fromOtherSupplier = onPo.filter(
    (ticket) =>
      ticket.supplierId !== null &&
      line.supplierId !== null &&
      ticket.supplierId !== line.supplierId
  );
  // Same rule for the material: a different product is excluded, an unreadable
  // one is counted and said so. Where the line's own product could not be read
  // there is nothing to compare against, so nothing is excluded on that basis.
  const onPoThisSupplier = onPo.filter((ticket) => !fromOtherSupplier.includes(ticket));
  const ticketProduct = (ticket: DeliveredTicket): string | null =>
    resolveProduct(ticket.supplierId ?? line.supplierId, ticket.material, inputs.aliases);

  const carryingAnotherProduct =
    productName === null
      ? []
      : onPoThisSupplier.filter((ticket) => {
          const material = ticketProduct(ticket);
          return material !== null && material !== productName;
        });

  const relevant = onPoThisSupplier.filter((ticket) => !carryingAnotherProduct.includes(ticket));
  // Counted, but with something missing from the paper. Reported so a person
  // can see what the total actually rests on — measured over the tickets that
  // were counted, not over everything on the PO.
  const materialUnknown = relevant.filter((ticket) => ticketProduct(ticket) === null);
  const supplierUnknown = relevant.filter((ticket) => ticket.supplierId === null);

  /** What was set aside and why, appended to whatever the coverage check says. */
  const exclusions: string[] = [];
  if (fromOtherSupplier.length > 0) {
    exclusions.push(
      `${fromOtherSupplier.length} ticket${fromOtherSupplier.length === 1 ? '' : 's'} on this PO ` +
        `${fromOtherSupplier.length === 1 ? 'belongs' : 'belong'} to another supplier and ${fromOtherSupplier.length === 1 ? 'was' : 'were'} not counted`
    );
  }
  if (carryingAnotherProduct.length > 0) {
    exclusions.push(
      `${carryingAnotherProduct.length} ticket${carryingAnotherProduct.length === 1 ? '' : 's'} on this PO ` +
        `${carryingAnotherProduct.length === 1 ? 'carries' : 'carry'} a different product and ${carryingAnotherProduct.length === 1 ? 'was' : 'were'} not counted`
    );
  }
  if (materialUnknown.length > 0) {
    exclusions.push(
      `${materialUnknown.length} counted ticket${materialUnknown.length === 1 ? '' : 's'} ` +
        `${materialUnknown.length === 1 ? 'does' : 'do'} not say what ${materialUnknown.length === 1 ? 'it was' : 'they were'} carrying`
    );
  }
  if (supplierUnknown.length > 0) {
    exclusions.push(
      `${supplierUnknown.length} counted ticket${supplierUnknown.length === 1 ? '' : 's'} ` +
        `${supplierUnknown.length === 1 ? 'does' : 'do'} not name a supplier`
    );
  }
  const noted = (detail: string): string =>
    exclusions.length === 0 ? detail : `${detail}. ${exclusions.join('; ')}`;

  // A load already paid for on another line is spent. Counting it again is how
  // the same delivery gets paid twice, which is the one thing this system
  // exists to prevent — and before this check it did so with every status
  // green, which is worse than not checking.
  //
  // A claim made by *this* line is this line's own history: a recompute must
  // not conflict with the verdict a person already settled.
  const usedElsewhere = relevant.filter(
    // `!= null` on purpose: an absent claim and a null claim both mean nobody
    // has paid against this load.
    (ticket) => ticket.claim != null && ticket.claim.invoiceLineId !== line.id
  );
  const available = relevant.filter((ticket) => !usedElsewhere.includes(ticket));

  const comparable = available.filter(
    (ticket) => ticket.quantity !== null && compareUnits(line.unit, ticket.unit).comparable
  );
  // What a later resolution will claim: what this verdict actually counted, and
  // nothing else. Claiming everything merely *available* spent loads this line
  // never used — a ticket in an incomparable unit, or a second product's load
  // on the same PO — and the line that really needed them then read "every
  // ticket on this PO has already been used".
  const ticketIds = comparable.map((ticket) => ticket.id);

  if (relevant.length === 0) {
    checks.push({
      name: 'ticketCoverage',
      passed: false,
      detail: noted(
        onPo.length === 0
          ? 'No delivery ticket accounts for this line'
          : `${onPo.length} ticket${onPo.length === 1 ? '' : 's'} carry this PO, but none of them belong to this line`
      ),
      expected: line.quantity,
      found: 0,
    });
  } else if (available.length === 0) {
    // Every load left for this line is already spoken for. Saying "no
    // comparable unit" here would send a clerk hunting for the wrong problem.
    checks.push({
      name: 'ticketCoverage',
      passed: false,
      detail: noted(
        'Every ticket that could cover this line has already been used to pay another invoice line, so nothing is left'
      ),
      expected: line.quantity,
      found: 0,
    });
  } else if (comparable.length === 0) {
    checks.push({
      name: 'ticketCoverage',
      passed: false,
      detail: noted(
        `${available.length} ticket${available.length === 1 ? '' : 's'} could cover this line, but none are recorded in a unit comparable with "${line.unit ?? 'none'}"`
      ),
      expected: line.quantity,
      found: 0,
    });
  } else if (line.quantity === null) {
    checks.push({
      name: 'ticketCoverage',
      passed: false,
      detail: noted('No quantity could be read from the invoice line, so coverage was not checked'),
    });
  } else {
    const delivered = comparable.reduce((total, ticket) => total + (ticket.quantity as number), 0);
    const difference = percentDifference(line.quantity, delivered);
    const passed = withinTolerance(difference, inputs.tolerances.quantityTolerancePct);

    // Worded as the screens word it: positive means billed for more than
    // arrived. The engine's own delta below keeps the opposite sign because it
    // reads as "found against expected" everywhere else in the evidence.
    if (!passed) {
      totals.quantityDiscrepancy = Number((line.quantity - delivered).toFixed(4));
    }

    checks.push({
      name: 'ticketCoverage',
      passed,
      detail: noted(
        passed
          ? `${comparable.length} ticket${comparable.length === 1 ? '' : 's'} account for the billed quantity`
          : Number.isFinite(difference)
            ? `Billed ${line.quantity} but tickets account for ${delivered}, a difference of ${difference.toFixed(1)}%`
            : `The line bills a quantity of 0 but tickets account for ${delivered}`
      ),
      expected: line.quantity,
      found: delivered,
      delta: Number((delivered - line.quantity).toFixed(4)),
    });
  }

  const coveragePassed = checks.find((check) => check.name === 'ticketCoverage')?.passed === true;

  // Reuse only *fails* when the remaining tickets cannot cover the line.
  //
  // A supplier legitimately sends a second invoice for a second load on the
  // same PO, and failing that every time would paint a normal week yellow —
  // which teaches a clerk to click through warnings, and a warning nobody
  // reads protects nobody.
  if (usedElsewhere.length > 0) {
    const first = usedElsewhere[0]!.claim as TicketClaimRef;
    const names = usedElsewhere
      .map((ticket) => ticket.ticketNumber ?? ticket.id.slice(0, 6))
      .join(' and ');
    const total = usedElsewhere.reduce((sum, ticket) => sum + (ticket.quantity ?? 0), 0);
    const plural = usedElsewhere.length > 1;
    const claimedBy = first.claimedByName ? `, confirmed by ${first.claimedByName}` : '';

    checks.push({
      name: 'ticketReuse',
      passed: coveragePassed,
      detail: coveragePassed
        ? `Ticket${plural ? 's' : ''} ${names} on this PO ${plural ? 'were' : 'was'} already used to pay invoice ${first.invoiceNumber} and ${plural ? 'were' : 'was'} not counted. The remaining tickets cover this line.`
        : `Ticket${plural ? 's' : ''} ${names}${total ? ` (${Number(total.toFixed(4))} ${line.unit ?? ''})`.trimEnd() : ''} ${plural ? 'were' : 'was'} already used to pay invoice ${first.invoiceNumber} line ${first.lineNumber}${claimedBy}. Paying this line would pay for ${plural ? 'those loads' : 'that load'} twice.`,
      expected: line.quantity,
      found: usedElsewhere.length,
    });
  } else if (relevant.length > 0) {
    checks.push({
      name: 'ticketReuse',
      passed: true,
      detail: 'No ticket on this line has been used to pay another invoice.',
    });
  }

  // Unsettled contention. Both lines see each other, so neither is green purely
  // for having been matched first.
  const competitors = inputs.competingLines.filter(
    (competitor) => competitor.invoiceLineId !== line.id
  );
  if (competitors.length > 0) {
    const first = competitors[0]!;
    const dated = first.invoiceDate
      ? ` (dated ${first.invoiceDate.toISOString().slice(0, 10)})`
      : '';
    checks.push({
      name: 'duplicateBilling',
      passed: false,
      detail: `PO ${line.poNumber} is also billed on invoice ${first.invoiceNumber} line ${first.lineNumber}${dated}, which has not been reviewed yet. The same tickets would count towards both. Check whether one of these invoices is a repeat.`,
      found: competitors.length,
    });
  }

  return { ...decide(order, candidates, checks, 'invoice line'), ticketIds, checks, totals };
}
