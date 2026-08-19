/**
 * Day boundaries in the timezone the business actually operates in.
 *
 * Three different notions of "today" were in play. The browser sent
 * `new Date().toISOString().split('T')[0]`, which is the UTC calendar date; the
 * server called `setHours(0, 0, 0, 0)`, which is midnight in whatever zone the
 * host happens to run in (UTC on Railway); and the yard runs on Ontario time.
 *
 * The visible symptom was that after 20:00 in Cambridge the "Today" filter
 * asked for tomorrow's date and came back empty, while the dispatch board's
 * "today" had already started at 20:00 the previous evening.
 *
 * Everything that means "a day" now resolves through here.
 */

export const BUSINESS_TIME_ZONE = 'America/Toronto';

const DAY_MS = 24 * 60 * 60 * 1000;

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Offset of the business zone from UTC at a given instant, in milliseconds.
 *
 * Derived by formatting the instant in the target zone and reading the result
 * back as though it were UTC. The gap between the two is the offset, which is
 * what makes this correct across the DST switch rather than assuming -05:00.
 */
function zoneOffsetMs(instant: Date): number {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Some ICU builds render midnight as hour 24 under hour12: false.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return asIfUtc - instant.getTime();
}

/** Splits a 'YYYY-MM-DD' string, returning null for anything else. */
function parseIsoDate(isoDate: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Date.UTC normalises impossible dates (for example 31 February) into the
  // following month. Reject those instead of silently querying a different day.
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) return null;

  return { year, month, day };
}

/**
 * The instant at which the given business day begins, as a UTC `Date`.
 *
 * Returns null for input that is not a 'YYYY-MM-DD' calendar date, so callers
 * can reject a bad filter rather than silently widening the query.
 */
export function startOfBusinessDay(isoDate: string): Date | null {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return null;

  const naiveUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0, 0);

  // The offset depends on the instant, and the instant depends on the offset.
  // Applying the first guess and re-measuring settles it; the second pass only
  // changes anything on the two days a year the clocks move.
  const firstGuess = new Date(naiveUtc - zoneOffsetMs(new Date(naiveUtc)));
  return new Date(naiveUtc - zoneOffsetMs(firstGuess));
}

/**
 * The last representable instant of the given business day, as a UTC `Date`.
 *
 * Derived from the start of the next day so it stays correct on the 23- and
 * 25-hour days, which a fixed `23:59:59.999` would not.
 */
export function endOfBusinessDay(isoDate: string): Date | null {
  const start = startOfBusinessDay(isoDate);
  if (!start) return null;

  const nextDay = businessDayOf(new Date(start.getTime() + DAY_MS + DAY_MS / 2));
  const nextStart = startOfBusinessDay(nextDay);
  if (!nextStart) return null;

  return new Date(nextStart.getTime() - 1);
}

/** The 'YYYY-MM-DD' business-zone calendar date containing the given instant. */
export function businessDayOf(instant: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Half-open range covering one business day, shaped for a Prisma date filter.
 *
 * Returns null on unparseable input. Callers must treat that as "reject the
 * request", never as "no filter" — dropping an unparseable date filter is how
 * a request for one day quietly returns the entire table.
 */
export function businessDayRange(isoDate: string): { gte: Date; lte: Date } | null {
  const gte = startOfBusinessDay(isoDate);
  const lte = endOfBusinessDay(isoDate);
  if (!gte || !lte) return null;
  return { gte, lte };
}
