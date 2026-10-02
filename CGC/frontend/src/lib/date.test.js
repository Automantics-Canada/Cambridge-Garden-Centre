/* global process -- vitest runs in Node; TZ is switched to test other zones. */
import { afterEach, describe, expect, it } from 'vitest';
import { formatCalendarDate, formatDate } from './date';

const localDay = (year, month, day, ...args) =>
  new Date(year, month - 1, day).toLocaleDateString(...args);

describe('formatCalendarDate', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    // process.env turns undefined into the string "undefined", so delete instead.
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('prints a UTC-midnight calendar date as that day, not the day before', () => {
    expect(formatCalendarDate('2026-08-14T00:00:00.000Z')).toBe(localDay(2026, 8, 14));
    expect(formatCalendarDate(new Date('2026-08-14T00:00:00.000Z'))).toBe(localDay(2026, 8, 14));
    expect(formatCalendarDate('2026-08-14')).toBe(localDay(2026, 8, 14));
    expect(formatCalendarDate('2026-12-31T00:00:00.000Z', 'en-CA')).toBe('2026-12-31');
  });

  it('keeps the formatDate arguments: a locale, or an options object', () => {
    expect(formatCalendarDate('2026-08-14T00:00:00.000Z', 'en-CA')).toBe('2026-08-14');
    expect(formatCalendarDate('2026-08-14T00:00:00.000Z', { dateStyle: 'long' }))
      .toBe(localDay(2026, 8, 14, undefined, { dateStyle: 'long' }));
    expect(formatCalendarDate('2026-08-14T00:00:00.000Z', 'en-US', { month: 'short', day: 'numeric' }))
      .toBe('Aug 14');
  });

  it('shows the same day in Ontario, where formatDate shows the day before', () => {
    process.env.TZ = 'America/Toronto';
    expect(formatDate('2026-08-14T00:00:00.000Z', 'en-CA')).toBe('2026-08-13');
    expect(formatCalendarDate('2026-08-14T00:00:00.000Z', 'en-CA')).toBe('2026-08-14');
    expect(formatCalendarDate('2026-01-01T00:00:00.000Z', 'en-CA')).toBe('2026-01-01');
  });

  it('shows the same day east of UTC too', () => {
    process.env.TZ = 'Pacific/Kiritimati';
    expect(formatCalendarDate('2026-08-14T00:00:00.000Z', 'en-CA')).toBe('2026-08-14');
  });

  it('says "Not recorded" for missing dates', () => {
    expect(formatCalendarDate(null)).toBe('Not recorded');
    expect(formatCalendarDate(undefined)).toBe('Not recorded');
    expect(formatCalendarDate('')).toBe('Not recorded');
  });

  it('says "Not recorded" for values that are not a date', () => {
    expect(formatCalendarDate('not a date')).toBe('Not recorded');
    expect(formatCalendarDate('2026-02-30T00:00:00.000Z')).toBe('Not recorded');
    expect(formatCalendarDate('2026-13-01')).toBe('Not recorded');
    expect(formatCalendarDate(new Date('nope'))).toBe('Not recorded');
    expect(formatCalendarDate({})).toBe('Not recorded');
  });
});
