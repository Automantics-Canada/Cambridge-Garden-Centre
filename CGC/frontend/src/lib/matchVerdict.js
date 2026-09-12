/**
 * How a match verdict is presented on the verification desk.
 *
 * The rule this file exists to enforce: **a status never looks better than it
 * is.** The screen it replaces showed a green MATCHED badge that nothing had
 * computed, and a person approving invoices trusted it. So PARTIAL and CONFLICT
 * are given their own colour and their own words, and none of them are green.
 *
 * Kept separate from the component so the wording and the severity ordering can
 * be tested without rendering anything.
 */

/** Statuses in the order a person should deal with them: worst first. */
export const VERDICT_SEVERITY = ['CONFLICT', 'UNMATCHED', 'PARTIAL', 'MATCHED'];

const PRESENTATION = {
  MATCHED: {
    label: 'Matched',
    tone: 'good',
    summary: 'Every check passed against the order.',
  },
  PARTIAL: {
    label: 'Needs review',
    tone: 'warn',
    summary: 'An order was found, but something does not agree.',
  },
  UNMATCHED: {
    label: 'No order found',
    tone: 'neutral',
    summary: 'Nothing on file matches this line.',
  },
  CONFLICT: {
    label: 'Several orders fit',
    tone: 'bad',
    summary: 'More than one order fits. Someone has to choose.',
  },
};

const NOT_EVALUATED = {
  label: 'Not checked yet',
  tone: 'neutral',
  summary: 'This line has not been evaluated against an order.',
};

/**
 * The label, tone and one-line summary for a verdict.
 *
 * An absent verdict is "not checked yet", never a pass. A line nothing has
 * looked at must not be indistinguishable from one that cleared every check.
 */
export function describeVerdict(matchResult) {
  if (!matchResult || !matchResult.status) return { ...NOT_EVALUATED, status: null };
  const presentation = PRESENTATION[matchResult.status];
  if (!presentation) return { ...NOT_EVALUATED, status: matchResult.status };
  return { ...presentation, status: matchResult.status };
}

/** The checks behind a verdict, failures first so the problem is not buried. */
export function orderedChecks(matchResult) {
  const evidence = Array.isArray(matchResult?.evidence) ? matchResult.evidence : [];
  return [...evidence].sort((a, b) => Number(a.passed) - Number(b.passed));
}

/** How many checks failed. Drives the "2 of 5 checks failed" line. */
export function checkTally(matchResult) {
  const evidence = Array.isArray(matchResult?.evidence) ? matchResult.evidence : [];
  const failed = evidence.filter((check) => !check.passed).length;
  return { total: evidence.length, failed, passed: evidence.length - failed };
}

/**
 * Whether a person still has to act on this line.
 *
 * A resolved verdict is done regardless of its status — someone looked at a
 * discrepancy and accepted it, and continuing to nag about it would train
 * people to ignore the screen.
 */
export function needsAttention(matchResult) {
  if (!matchResult) return true;
  if (matchResult.resolution) return false;
  return matchResult.status !== 'MATCHED';
}

/** Sorts line items so the ones needing a person come first. */
export function bySeverity(a, b) {
  const rank = (item) => {
    const status = item?.matchResult?.status;
    const index = VERDICT_SEVERITY.indexOf(status);
    // An unevaluated line sits with the unmatched ones: it is not a pass.
    return index === -1 ? VERDICT_SEVERITY.indexOf('UNMATCHED') : index;
  };
  return rank(a) - rank(b);
}

/** Names a check in words a person reading an invoice would use. */
export function checkTitle(name) {
  switch (name) {
    case 'po':
      return 'Purchase order';
    case 'supplier':
      return 'Supplier and date';
    case 'date':
      return 'Date';
    case 'product':
      return 'Product';
    case 'quantity':
      return 'Quantity';
    case 'rate':
      return 'Rate';
    case 'ticketCoverage':
      return 'Delivery tickets';
    case 'ticketReuse':
      return 'Tickets already paid against';
    case 'duplicateBilling':
      return 'Also billed elsewhere';
    default:
      return name;
  }
}
