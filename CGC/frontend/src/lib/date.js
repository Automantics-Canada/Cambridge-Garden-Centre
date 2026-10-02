/**
 * Format a date for the UI. Missing or unparseable values become
 * "Not recorded" so the user never sees the literal "Invalid Date".
 *
 * `locale` may be a BCP 47 tag, or an options object when the caller
 * only wants `toLocaleDateString(undefined, options)`.
 */
/**
 * Timezone the business runs in. "Today" has to mean today in Cambridge,
 * Ontario, not today in UTC and not today on the viewer's laptop.
 *
 * `new Date().toISOString().split('T')[0]` was used for this and gives the UTC
 * date, so from 20:00 local onwards the "Today" filter asked the server for
 * tomorrow and came back empty for the rest of the working evening.
 *
 * Matches `BUSINESS_TIME_ZONE` in the backend's `lib/businessDay.ts`; the two
 * must agree or a filter means different things at each end.
 */
export const BUSINESS_TIME_ZONE = 'America/Toronto';

const businessDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The 'YYYY-MM-DD' business-zone date for an instant, defaulting to now.
 *
 * `en-CA` formats as YYYY-MM-DD, which is the shape the API expects.
 */
export function businessDayOf(instant = new Date()) {
  return businessDayFormatter.format(instant);
}

/**
 * The business-zone date `offset` days from today. Negative goes backwards.
 *
 * Shifts the calendar date rather than subtracting 24 hours from the instant.
 * On the two days a year the clocks move, a day is 23 or 25 hours long, and
 * "now minus 24h" lands on the wrong date.
 */
export function businessDayOffset(offset) {
  const [year, month, day] = businessDayOf().split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

export function formatDate(value, locale, options) {
  if (value == null || value === '') return 'Not recorded';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  if (locale && typeof locale === 'object') {
    return date.toLocaleDateString(undefined, locale);
  }
  return date.toLocaleDateString(locale, options);
}

/**
 * Format a calendar date (a `@db.Date` column such as an invoice date) for the
 * UI, taking the same arguments as `formatDate`.
 *
 * The API sends calendar dates as UTC midnight, "2026-08-14T00:00:00.000Z".
 * `formatDate` prints that in the viewer's zone, which in Ontario is Aug 13.
 * The day is read off the string instead, as `formatDeliveryDay` does.
 * Real timestamps (receivedAt, verifiedAt) still go through `formatDate`.
 */
export function formatCalendarDate(value, locale, options) {
  let text = value;
  if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text == null ? '' : String(text));
  if (!match) return formatDate(null);
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  // Reject days that roll over, such as 2026-02-30.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return formatDate(null);
  return formatDate(date, locale, options);
}

export default formatDate;
