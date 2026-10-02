import { describe, expect, it } from 'vitest';
import {
  canCorrectHistory,
  deliveryDay,
  formatDeliveryDay,
  isPastDay,
  returnsTo,
  upcomingSummary,
} from './dispatchDays';

describe('board days', () => {
  it('treats only days before today as history', () => {
    expect(isPastDay('2026-08-14', '2026-08-15')).toBe(true);
    expect(isPastDay('2026-08-15', '2026-08-15')).toBe(false);
    expect(isPastDay('2026-08-17', '2026-08-15')).toBe(false);
    expect(isPastDay('2026-12-31', '2027-01-01')).toBe(true);
    // No day chosen yet is not history.
    expect(isPastDay('', '2026-08-15')).toBe(false);
  });

  it('reads a delivery date as the calendar day it is, whatever the viewer\'s zone', () => {
    expect(deliveryDay('2026-08-14T00:00:00.000Z')).toBe('2026-08-14');
    expect(deliveryDay(new Date('2026-08-14T00:00:00.000Z'))).toBe('2026-08-14');
    expect(deliveryDay(null)).toBe(null);
    expect(deliveryDay('not a date')).toBe(null);
  });

  it('prints the delivery day, not the day before', () => {
    const shown = formatDeliveryDay('2026-08-14T00:00:00.000Z', { dateStyle: 'long' });
    expect(shown).toBe(new Date(2026, 7, 14).toLocaleDateString(undefined, { dateStyle: 'long' }));
    expect(formatDeliveryDay(null)).toBe('Not recorded');
  });

  it('lets only admins and owners correct a past day', () => {
    expect(canCorrectHistory('ADMIN')).toBe(true);
    expect(canCorrectHistory('OWNER')).toBe(true);
    expect(canCorrectHistory('AP_USER')).toBe(false);
    expect(canCorrectHistory(undefined)).toBe(false);
  });
});

describe('where an unassigned order goes back to', () => {
  const order = (date) => ({ id: 'doc-1', wholeOrder: true, deliveryDate: `${date}T00:00:00.000Z` });

  it('goes back to the pool of its own day', () => {
    expect(returnsTo(order('2026-08-15'), '2026-08-15', '2026-08-15')).toBe('pool');
    expect(returnsTo(order('2026-08-17'), '2026-08-17', '2026-08-15')).toBe('pool');
  });

  it('goes to Carried over when it was due before today and today is shown', () => {
    expect(returnsTo(order('2026-08-14'), '2026-08-15', '2026-08-15')).toBe('carriedOver');
  });

  it('leaves the board when it belongs to another day', () => {
    expect(returnsTo(order('2026-08-17'), '2026-08-15', '2026-08-15')).toBe(null);
    expect(returnsTo(order('2026-08-13'), '2026-08-17', '2026-08-15')).toBe(null);
  });

  it('keeps a stop made before whole orders in the pool, as before', () => {
    expect(returnsTo({ id: 'line-1', wholeOrder: false }, '2026-08-15', '2026-08-15')).toBe('pool');
  });
});

describe('upcoming days', () => {
  it('says how many orders, and how many still need a driver', () => {
    expect(upcomingSummary({ count: 1, unassigned: 0 })).toBe('1 order');
    expect(upcomingSummary({ count: 3, unassigned: 2 })).toBe('3 orders · 2 to assign');
  });
});
