import { formatDate } from './date';

/**
 * The dispatch board's days. Every day is a 'YYYY-MM-DD' calendar date in the
 * yard's timezone; ISO dates sort as strings, so comparing needs no parsing.
 */

/** Yesterday and older are history, and read-only. */
export const isPastDay = (day, today) => Boolean(day && today) && day < today;

/**
 * The 'YYYY-MM-DD' of a delivery date as the API sends it,
 * "2026-08-14T00:00:00.000Z", or null.
 *
 * Delivery dates are calendar dates sent as UTC midnight. Handing that to
 * `new Date()` and printing it in Ontario shows the day before, so the date is
 * read off the string instead.
 */
export function deliveryDay(value) {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** A delivery date for display, as the calendar date it is. */
export function formatDeliveryDay(value, options) {
  const day = deliveryDay(value);
  return day ? formatDate(`${day}T00:00:00`, options) : formatDate(null);
}

/** Admins and owners may still correct a stop's status on a past day. */
export const canCorrectHistory = (role) => role === 'ADMIN' || role === 'OWNER';

/**
 * Where an order goes back to when it is taken off a driver, on the board for
 * `poolDate`: 'carriedOver' when it was due before today and today is shown,
 * 'pool' when it is due on the day shown, and null when it belongs to neither.
 */
export function returnsTo(order, poolDate, today) {
  const due = deliveryDay(order?.deliveryDate);
  if (!order?.wholeOrder || !due) return 'pool';
  if (due === poolDate) return 'pool';
  if (poolDate === today && isPastDay(due, today)) return 'carriedOver';
  return null;
}

/** "2 orders · 1 to assign" for a day ahead. */
export function upcomingSummary({ count, unassigned }) {
  const orders = `${count} order${count === 1 ? '' : 's'}`;
  return unassigned > 0 ? `${orders} · ${unassigned} to assign` : orders;
}
