/**
 * Purchase order numbers, reduced to something two documents can be compared on.
 *
 * Two forms are in use. CGC's own POs were six digits (`355356`). Spruce prints
 * its POs as a four digit prefix, a dash and six digits (`2608-355356`), and the
 * same PO turns up on paper as `2608 355356`, `PO# 2608-355356`, or — where a
 * yard writes only the part it reads aloud — `355356`.
 *
 * The key is `{ prefix, suffix }`:
 *
 *   - `suffix` is the six digit number. It is always present.
 *   - `prefix` is the four digits in front of it, or null when the document did
 *     not print any.
 *
 * Two keys are the same PO when their suffixes are equal and their prefixes do
 * not contradict each other: equal, or at least one side absent. So
 * `355356` is compatible with `2608-355356`, while `2607-355356` and
 * `2608-355356` are two different POs and never match, however alike the last
 * six digits are. A prefix is evidence; it is never thrown away to make a match.
 *
 * Nothing stored is rewritten to compare. The key is derived at the moment of
 * comparison, so a value read off a ticket last year, typed in by hand, or
 * printed by Spruce today is compared on the same terms without a backfill.
 */

export interface PoKey {
  /** The four digits before the dash, when the document printed them. */
  prefix: string | null;
  /** The six digit number every form carries. */
  suffix: string;
}

/**
 * Labels written in front of the number: `PO`, `PO#`, `P.O. No.`, `Purchase
 * Order:`. Stripped before the shape is checked.
 */
const LABEL = /^(?:p\.?\s*o\.?|purchase\s+order)\s*(?:#|no\.?|num(?:ber)?\.?)?\s*[:#]?\s*/i;

/**
 * The Spruce form. The separator is a dash of any width or whitespace.
 *
 * Ten digits run together are deliberately not accepted: that is also the
 * shape of a phone number, and a phone number read as a PO would link a load
 * to whichever order happened to share its last six digits.
 */
const SPRUCE_FORM = /^(\d{4})\s*[-‐-―−]\s*(\d{6})$|^(\d{4})\s+(\d{6})$/;

/**
 * The key a PO number compares on, or null when it is not a PO in either form.
 *
 * The six digit rule is the one extraction has always applied: any text that
 * leaves exactly six digits once everything else is removed (`PO# 123456`,
 * `123-456`). It is kept as it was so nothing that matched before stops
 * matching.
 */
export function poKey(value: string | null | undefined): PoKey | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const unlabelled = text.replace(LABEL, '').trim();
  const spruce = SPRUCE_FORM.exec(unlabelled);
  if (spruce) {
    return { prefix: (spruce[1] ?? spruce[3]) as string, suffix: (spruce[2] ?? spruce[4]) as string };
  }

  const digits = text.replace(/\D/g, '');
  if (digits.length === 6) return { prefix: null, suffix: digits };

  return null;
}

/** `2608-355356` or `355356`: the key written the way Spruce prints it. */
export function formatPoKey(key: PoKey): string {
  return key.prefix ? `${key.prefix}-${key.suffix}` : key.suffix;
}

/** The canonical spelling of a PO, or null when it is not one. */
export function canonicalPoNumber(value: string | null | undefined): string | null {
  const key = poKey(value);
  return key ? formatPoKey(key) : null;
}

/**
 * Whether two written POs name the same purchase order.
 *
 * False whenever either side is not a PO at all: an unreadable value is not
 * evidence of anything, and two unreadable values agreeing is less so.
 */
export function poNumbersMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = poKey(a);
  const right = poKey(b);
  if (!left || !right) return false;
  if (left.suffix !== right.suffix) return false;
  return left.prefix === null || right.prefix === null || left.prefix === right.prefix;
}

/**
 * Whether a ticket or invoice line is "on" a PO for coverage and contention.
 *
 * The key comparison, plus the old exact-text rule for values that are not a
 * PO in either form. Two documents that both print the same unreadable value
 * were counted together before this key existed, and still are — an invoice
 * line must not lose its tickets because the key does not recognise their PO.
 */
export function onSamePo(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  if (a.trim() !== '' && a.trim() === b.trim()) return true;
  return poNumbersMatch(a, b);
}
