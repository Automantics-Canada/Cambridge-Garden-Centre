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
  name: 'po' | 'supplier' | 'date' | 'product' | 'quantity' | 'rate' | 'ticketCoverage';
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

/** A ticket already accepted as evidence, used to cover an invoice line. */
export interface DeliveredTicket {
  id: string;
  poNumber: string | null;
  quantity: number | null;
  unit: string | null;
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
      : `Quantity differs from the order by ${difference.toFixed(1)}%, beyond the ${tolerancePct}% allowed`,
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

  return { ...decide(order, candidates, checks, 'ticket'), ticketIds: [], checks };
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
  const agreed = productName
    ? inputs.agreedRates.find(
        (rate) => normalizeProductName(rate.productName) === productName
      )
    : undefined;

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
      checks.push({
        name: 'rate',
        passed,
        detail: passed
          ? 'Billed rate matches the agreed rate'
          : `Billed at ${line.unitRate} against an agreed ${agreed.rate} per ${agreed.unit}, ${difference.toFixed(1)}% above the ${inputs.tolerances.priceTolerancePct}% allowed`,
        expected: agreed.rate,
        found: line.unitRate,
        delta: Number((line.unitRate - agreed.rate).toFixed(4)),
      });
    }
  }

  // Ticket coverage. One invoice line can cover several truckloads, so the
  // tickets are summed — but only those recorded in a unit the line can be
  // compared against, because a mixed total would be confidently wrong.
  const relevant = inputs.tickets.filter((ticket) => ticket.poNumber === line.poNumber);
  const comparable = relevant.filter(
    (ticket) => ticket.quantity !== null && compareUnits(line.unit, ticket.unit).comparable
  );
  const ticketIds = relevant.map((ticket) => ticket.id);

  if (relevant.length === 0) {
    checks.push({
      name: 'ticketCoverage',
      passed: false,
      detail: 'No delivery ticket accounts for this line',
      expected: line.quantity,
      found: 0,
    });
  } else if (comparable.length === 0) {
    checks.push({
      name: 'ticketCoverage',
      passed: false,
      detail: `${relevant.length} ticket${relevant.length === 1 ? '' : 's'} carry this PO, but none are recorded in a unit comparable with "${line.unit ?? 'none'}"`,
      expected: line.quantity,
    });
  } else if (line.quantity === null) {
    checks.push({
      name: 'ticketCoverage',
      passed: false,
      detail: 'No quantity could be read from the invoice line, so coverage was not checked',
    });
  } else {
    const delivered = comparable.reduce((total, ticket) => total + (ticket.quantity as number), 0);
    const difference = percentDifference(line.quantity, delivered);
    const passed = withinTolerance(difference, inputs.tolerances.quantityTolerancePct);
    checks.push({
      name: 'ticketCoverage',
      passed,
      detail: passed
        ? `${comparable.length} ticket${comparable.length === 1 ? '' : 's'} account for the billed quantity`
        : `Billed ${line.quantity} but tickets account for ${delivered}, a difference of ${difference.toFixed(1)}%`,
      expected: line.quantity,
      found: delivered,
      delta: Number((delivered - line.quantity).toFixed(4)),
    });
  }

  return { ...decide(order, candidates, checks, 'invoice line'), ticketIds, checks };
}
