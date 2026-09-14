import { LineItemFlag } from '@prisma/client';

/**
 * The one-word verdict shown beside an invoice line.
 *
 * `InvoiceLineItem.flag` is a conclusion, not a label, and it is reached from
 * two directions: the match engine writing what it just decided, and the manual
 * link and unlink handlers re-deriving it after somebody attaches an order or
 * detaches a ticket. Both went through their own copy of these rules once, and
 * they disagreed — attaching an order stamped `OK` and wiped a live rate
 * warning nobody had looked at. The rule lives here so there is one of it.
 *
 * Pure on purpose: it takes facts and returns a flag, so every branch is
 * testable without a database.
 */
export interface LineItemFacts {
  /** Exactly one order was matched to this line. */
  hasOrder: boolean;
  /** How many delivery tickets are recorded against it. */
  ticketCount: number;
  /** The billed quantity differs from what was accounted for, beyond tolerance. */
  hasQuantityDiscrepancy: boolean;
  /** The billed rate differs from the agreed rate, beyond tolerance. */
  hasRateDiscrepancy: boolean;
  /** An agreed rate was found and actually applied. */
  hasAgreedRate: boolean;
  /**
   * An agreed rate exists but is priced per a unit this line cannot be compared
   * against. Distinct from having no rate at all: this one is fixed by
   * correcting a unit, not by agreeing a price.
   */
  rateUnitMismatch: boolean;
}

/**
 * The schema keeps one flag per line rather than a set, so a line with more
 * than one problem reports MULTIPLE_FLAGS and sends the reader to the evidence
 * rather than picking whichever problem happened to be found first.
 */
export function deriveLineItemFlag(facts: LineItemFacts): LineItemFlag {
  const flags: LineItemFlag[] = [];

  if (!facts.hasOrder) flags.push(LineItemFlag.NO_ORDER);
  if (facts.ticketCount === 0) flags.push(LineItemFlag.NO_TICKET);
  if (facts.hasQuantityDiscrepancy) flags.push(LineItemFlag.QTY_MISMATCH);

  if (facts.hasRateDiscrepancy) {
    flags.push(LineItemFlag.RATE_MISMATCH);
  } else if (!facts.hasAgreedRate) {
    flags.push(facts.rateUnitMismatch ? LineItemFlag.UNIT_MISMATCH : LineItemFlag.RATE_UNKNOWN);
  }

  if (flags.length > 1) return LineItemFlag.MULTIPLE_FLAGS;
  return flags[0] ?? LineItemFlag.OK;
}
