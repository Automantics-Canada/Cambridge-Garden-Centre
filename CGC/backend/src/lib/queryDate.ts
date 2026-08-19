import { endOfBusinessDay, startOfBusinessDay } from './businessDay.js';

export class QueryDateError extends Error {
  status = 400;
}

/**
 * Parses a query-string date without changing what a calendar day means.
 *
 * Date inputs in the UI send YYYY-MM-DD. Those values describe a whole day in
 * Cambridge, not UTC midnight. Timestamp inputs remain exact for API clients
 * that intentionally send one.
 */
export function parseQueryDate(
  value: unknown,
  name: string,
  boundary: 'start' | 'end' | 'exact' = 'exact'
): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const start = startOfBusinessDay(raw);
    if (!start) throw new QueryDateError(`${name} is not a valid date`);
    if (boundary === 'start') return start;
    if (boundary === 'end') return endOfBusinessDay(raw)!;
    return new Date(`${raw}T00:00:00.000Z`);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new QueryDateError(`${name} is not a valid date`);
  }
  return parsed;
}
