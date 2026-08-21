/**
 * Dates as Spruce prints them.
 *
 * The importer used `new Date(raw)`, which reads "05/06/24" as 5 June in some
 * runtimes and 6 May in others, and in V8 resolves it as US month-first — so a
 * Canadian report reading 5 June was silently stored as 6 May. A month wrong on
 * an order date is a month wrong on every report built from it, and nothing
 * about the stored value looks suspicious afterwards.
 *
 * Parsing is therefore explicit. Unambiguous formats are accepted outright;
 * genuinely ambiguous slash dates are resolved with a declared convention
 * rather than the engine's default, and the convention is stated in one place.
 */

/**
 * How to read a slash date when both halves could be a month.
 *
 * Spruce is American software and prints its dates month-first by default;
 * every report observed from this yard follows that (`8/14/2026`, `08/17/26`).
 * Reading them day-first silently turned a September 2 order into February 9 —
 * a value nothing downstream flags. This is the one assumption in the parser
 * that cannot be derived from the file itself: a date like 8/14 settles itself
 * because 14 cannot be a month, but 9/2 does not. If a report ever arrives
 * genuinely day-first, change it here rather than at the call sites.
 */
export const SLASH_DATE_ORDER: 'DAY_FIRST' | 'MONTH_FIRST' = 'MONTH_FIRST';

function makeUtcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Stored as `@db.Date`, so the time component is irrelevant and UTC midnight
  // keeps the calendar date stable regardless of where this runs.
  const date = new Date(Date.UTC(year, month - 1, day));

  // Rejects impossible dates that Date would otherwise roll forward, such as
  // 31 February becoming 3 March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return date;
}

/** Two-digit years: 70–99 are 1900s, everything else 2000s. */
function expandYear(raw: number): number {
  if (raw >= 100) return raw;
  return raw >= 70 ? 1900 + raw : 2000 + raw;
}

/**
 * Parses a date as printed on a Spruce report. Returns null when the text is
 * not a date this function recognises, so the caller can record a row error
 * instead of storing a value nobody can account for.
 */
export function parseSpruceDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  // ISO — unambiguous by definition.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    return makeUtcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // Named month, either order: "5 Jun 2024" / "Jun 5, 2024".
  const named = /^(\d{1,2})[\s-]*([A-Za-z]{3,9})[\s,-]*(\d{2,4})$/.exec(text)
    ?? /^([A-Za-z]{3,9})[\s-]*(\d{1,2})[\s,-]*(\d{2,4})$/.exec(text);
  if (named) {
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const dayPart = /^\d/.test(named[1]!) ? named[1]! : named[2]!;
    const monthPart = /^\d/.test(named[1]!) ? named[2]! : named[1]!;
    const monthIndex = monthNames.indexOf(monthPart.slice(0, 3).toLowerCase());
    if (monthIndex >= 0) {
      return makeUtcDate(expandYear(Number(named[3])), monthIndex + 1, Number(dayPart));
    }
    return null;
  }

  // Slash or dot separated numeric: the ambiguous case.
  const numeric = /^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/.exec(text);
  if (!numeric) return null;

  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const third = Number(numeric[3]);

  // A four-digit leading value can only be the year: 2024/06/05.
  if (String(numeric[1]).length === 4) {
    return makeUtcDate(first, second, third);
  }

  const year = expandYear(third);

  // One of the first two being over 12 settles it without needing the
  // convention at all.
  if (first > 12 && second <= 12) return makeUtcDate(year, second, first);
  if (second > 12 && first <= 12) return makeUtcDate(year, first, second);

  return SLASH_DATE_ORDER === 'DAY_FIRST'
    ? makeUtcDate(year, second, first)
    : makeUtcDate(year, first, second);
}
