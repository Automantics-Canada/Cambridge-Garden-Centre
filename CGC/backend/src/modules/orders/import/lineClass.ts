/**
 * What each Spruce line is, read off its item code.
 *
 * A Spruce order mixes the material being delivered with lines that are not
 * material at all: the delivery charge, refundable skid deposits, comments and
 * surcharges. A driver needs the first and none of the rest, and the delivery
 * charge's own item code is the only place the order says how it is to be
 * delivered. The codes are the yard's own and stable, so these are exact
 * rules rather than guesses about descriptions.
 */

export type LineClass = 'PRODUCT' | 'DELIVERY_CHARGE' | 'DEPOSIT' | 'COMMENT' | 'SURCHARGE';

export type DeliveryType = 'SLINGER' | 'SPLITBOX' | 'FLATBED' | 'DUMP' | 'BAG' | 'GENERAL';

/** Bulk delivery tiers carry `YEL` in their code: `SOILYELSU3.5-6`, `AGGYEL1-3`. */
const BULK_TIER = /YEL(?!LOW)/;

export function classifyLine(itemCode: string | null | undefined, description: string | null | undefined): LineClass {
  const code = (itemCode ?? '').trim().toUpperCase();

  if (code === 'COMMENT' || code === 'RETURNCOMM') return 'COMMENT';
  // `RSKID`, `BSKID`, `USKID`: the refundable deposit on the skid it ships on.
  if (code.endsWith('SKID')) return 'DEPOSIT';
  if (code.startsWith('MISCDEL') || BULK_TIER.test(code)) return 'DELIVERY_CHARGE';
  if (/surcharge/i.test(description ?? '')) return 'SURCHARGE';
  return 'PRODUCT';
}

/**
 * How the order goes out, from its delivery charge.
 *
 * The specialist services are checked first: an order charged for a slinger
 * is a slinger job whatever else is on it. Bagged material is sold with the
 * delivery built in — its description ends `DEL` — so it has no charge line
 * of its own and is recognised from the product instead.
 */
export function deliveryTypeOf(
  lines: ReadonlyArray<{ itemCode?: string | null; description?: string | null }>
): DeliveryType | null {
  const codes = new Set(lines.map(line => (line.itemCode ?? '').trim().toUpperCase()));

  if (codes.has('MISCDELG')) return 'SLINGER';
  if (codes.has('MISCDELI')) return 'SPLITBOX';
  if (codes.has('MISCDELD')) return 'FLATBED';
  if ([...codes].some(code => BULK_TIER.test(code))) return 'DUMP';
  if (lines.some(line => /\bDEL$/i.test((line.description ?? '').trim()))) return 'BAG';
  if (codes.has('MISCDEL')) return 'GENERAL';
  return null;
}
