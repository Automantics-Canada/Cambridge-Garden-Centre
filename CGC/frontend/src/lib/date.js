/**
 * Format a date for the UI. Missing or unparseable values become
 * "Not recorded" so the user never sees the literal "Invalid Date".
 *
 * `locale` may be a BCP 47 tag, or an options object when the caller
 * only wants `toLocaleDateString(undefined, options)`.
 */
export function formatDate(value, locale, options) {
  if (value == null || value === '') return 'Not recorded';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  if (locale && typeof locale === 'object') {
    return date.toLocaleDateString(undefined, locale);
  }
  return date.toLocaleDateString(locale, options);
}

export default formatDate;
