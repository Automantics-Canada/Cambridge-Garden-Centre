/**
 * Day boundaries in the timezone the business operates in.
 *
 * Mirrors `CGC/backend/src/lib/businessDay.ts`. The Edge runtime cannot import
 * from the backend package, so the logic is duplicated deliberately — but the
 * timezone and the semantics must stay identical at both ends, or "today" means
 * one thing on the dispatch board and another on the orders screen.
 */

export const BUSINESS_TIME_ZONE = 'America/Toronto';

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

function zonePartsOf(instant: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/** Offset of the business zone from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: Date): number {
  const parts = zonePartsOf(instant);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - instant.getTime();
}

/** The 'YYYY-MM-DD' business-zone calendar date containing the given instant. */
export function businessDayOf(instant: Date = new Date()): string {
  const parts = zonePartsOf(instant);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The instant a business day begins, or null if the input is not YYYY-MM-DD. */
export function startOfBusinessDay(isoDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // Two passes: the offset depends on the instant it is measured at, which only
  // matters on the two days a year the clocks move.
  const firstGuess = new Date(naiveUtc - zoneOffsetMs(new Date(naiveUtc)));
  return new Date(naiveUtc - zoneOffsetMs(firstGuess));
}

/**
 * Half-open range covering one business day, as ISO strings for PostgREST.
 *
 * Returns null for unparseable input. Callers must reject the request rather
 * than drop the filter — an unfiltered dispatch board is the bug this fixes.
 */
export function businessDayRange(isoDate: string): { gte: string; lt: string } | null {
  const start = startOfBusinessDay(isoDate);
  if (!start) return null;

  // Derived from the next day's start so the 23- and 25-hour days stay correct.
  const nextDay = businessDayOf(new Date(start.getTime() + 36 * 60 * 60 * 1000));
  const nextStart = startOfBusinessDay(nextDay);
  if (!nextStart) return null;

  return { gte: start.toISOString(), lt: nextStart.toISOString() };
}
