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

  // `RETURNCOMM`, and `SALTCOMM`: the salt orders' payment terms, a page of
  // text priced at nothing.
  if (code === 'COMMENT' || code.endsWith('COMM')) return 'COMMENT';
  // `RSKID`, `BSKID`, `USKID`: the refundable deposit on the skid it ships on.
  if (code.endsWith('SKID')) return 'DEPOSIT';
  if (code.startsWith('MISCDEL') || BULK_TIER.test(code)) return 'DELIVERY_CHARGE';
  if (/surcharge/i.test(description ?? '')) return 'SURCHARGE';
  return 'PRODUCT';
}

/** The delivery charges whose code alone says how the order goes out. */
const LISTED_CHARGES = new Set(['MISCDEL', 'MISCDELG', 'MISCDELI', 'MISCDELD']);

const SLINGER = /\bslinger\b/i;
const TRI_AXLE = /\btri[\s-]?axle\b/i;

/**
 * How the order goes out, from its delivery charge.
 *
 * The specialist services are checked first: an order charged for a slinger
 * is a slinger job whatever else is on it. Bagged material is sold with the
 * delivery built in — its description ends `DEL` — so it has no charge line
 * of its own and is recognised from the product instead.
 *
 * A delivery charge under a code not listed here (721442's slinger is
 * `MISCDELE`) is read by its description instead: a slinger is a slinger, a
 * tri-axle is a dump truck, and anything else is still a delivery. The client
 * confirmed (Oct 2026) that any delivery charge on an order makes it one.
 */
export function deliveryTypeOf(
  lines: ReadonlyArray<{ itemCode?: string | null; description?: string | null }>
): DeliveryType | null {
  const codes = new Set(lines.map(line => (line.itemCode ?? '').trim().toUpperCase()));
  const unlisted = lines
    .filter(line => {
      const code = (line.itemCode ?? '').trim().toUpperCase();
      return code.startsWith('MISCDEL') && !LISTED_CHARGES.has(code);
    })
    .map(line => line.description ?? '');

  if (codes.has('MISCDELG') || unlisted.some(text => SLINGER.test(text))) return 'SLINGER';
  if (codes.has('MISCDELI')) return 'SPLITBOX';
  if (codes.has('MISCDELD')) return 'FLATBED';
  if ([...codes].some(code => BULK_TIER.test(code)) || unlisted.some(text => TRI_AXLE.test(text))) return 'DUMP';
  if (lines.some(line => /\bDEL$/i.test((line.description ?? '').trim()))) return 'BAG';
  if (codes.has('MISCDEL') || unlisted.length > 0) return 'GENERAL';
  return null;
}
