/**
 * What this invoice is approved to pay, and whether that can be said at all.
 *
 * The page this replaced computed an "Approved amount" as
 * `negotiatedRate || unitRate`, so a line with no agreed rate silently fell
 * back to the rate the supplier had billed. The screen then showed that figure
 * as the approved amount and a discrepancy of about zero — an invoice nobody
 * had checked, displaying as checked, using the supplier's own number as the
 * standard it was checked against.
 *
 * An approved amount only means something when every line has a rate CGC
 * actually agreed to. When one does not, there is no answer to give, so this
 * returns null and the caller says so rather than printing a number.
 */

/** Ontario HST. */
export const HST_RATE = 0.13;

/** A rate of zero is a real agreed rate; only null/undefined means "none on file". */
function hasAgreedRate(line) {
  return line?.negotiatedRate !== null && line?.negotiatedRate !== undefined;
}

export function summariseInvoiceApproval(lineItems, invoiceTotal) {
  const lines = Array.isArray(lineItems) ? lineItems : [];
  const unpriced = lines.filter((line) => !hasAgreedRate(line));

  // An invoice with no lines has nothing to approve either.
  const canApprove = lines.length > 0 && unpriced.length === 0;

  if (!canApprove) {
    return {
      canApprove: false,
      lineCount: lines.length,
      unpricedCount: unpriced.length,
      approvedTotal: null,
      discrepancy: null,
    };
  }

  const subtotal = lines.reduce(
    (total, line) => total + Number(line.quantity || 0) * Number(line.negotiatedRate),
    0
  );
  const approvedTotal = subtotal * (1 + HST_RATE);

  return {
    canApprove: true,
    lineCount: lines.length,
    unpricedCount: 0,
    approvedTotal,
    discrepancy: Number(invoiceTotal || 0) - approvedTotal,
  };
}
