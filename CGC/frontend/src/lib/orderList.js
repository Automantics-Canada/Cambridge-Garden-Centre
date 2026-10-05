/**
 * The Orders page's rules, kept apart from the screen so they can be tested.
 * Every day is a 'YYYY-MM-DD' calendar date in the yard's timezone.
 */

/** The delivery-status filter, in the order the menu lists it. */
export const DELIVERY_STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'pending', label: 'Not delivered yet' },
  { value: 'unassigned', label: 'No driver yet' },
  { value: 'assigned', label: 'With a driver' },
  { value: 'onTheWay', label: 'On the way' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];

const STARTED = ['OUT_FOR_DELIVERY', 'IN_TRANSIT'];

/**
 * Where an order stands, for its status badge: what to say, its tone, and the
 * driver's name under it. A pickup is collected at the yard and never gets a
 * stop, so it says so rather than "No driver".
 */
export function deliveryStatusView(order) {
  if (order?.isPickup) return { label: 'Pickup at yard', tone: 'neutral', detail: null };
  const delivery = order?.delivery;
  const driver = delivery?.driverName ?? null;
  if (!delivery || (!driver && delivery.status !== 'DELIVERED' && delivery.status !== 'CANCELLED')) {
    return { label: 'No driver yet', tone: 'warn', detail: null };
  }
  switch (delivery.status) {
    case 'DELIVERED': return { label: 'Delivered', tone: 'good', detail: driver };
    case 'CANCELLED': return { label: 'Cancelled', tone: 'bad', detail: driver };
    case 'ON_HOLD': return { label: 'On hold', tone: 'warn', detail: driver };
    case 'DELAYED': return { label: 'Delayed', tone: 'warn', detail: driver };
    default:
      return STARTED.includes(delivery.status)
        ? { label: 'On the way', tone: 'warn', detail: driver }
        : { label: 'With driver', tone: 'neutral', detail: driver };
  }
}

/**
 * The upload days to ask for. Today, yesterday, every day, or a range of days;
 * a range with one end chosen is that one day. Null while a range has no day
 * chosen yet, so nothing is fetched until one is.
 */
export function uploadRange({ filter, from, to, today, yesterday }) {
  if (filter === 'today') return { uploadStartDate: today, uploadEndDate: today };
  if (filter === 'yesterday') return { uploadStartDate: yesterday, uploadEndDate: yesterday };
  if (filter === 'all') return {};
  const start = from || to;
  const end = to || from;
  if (!start) return null;
  // Picked the wrong way round, the range still means the days between.
  return start <= end
    ? { uploadStartDate: start, uploadEndDate: end }
    : { uploadStartDate: end, uploadEndDate: start };
}

/** The empty list's heading, for what was asked. */
export function emptyTitle({ filter, from, to, filtered }) {
  if (filter === 'range' && !from && !to) return 'Pick the days';
  if (filtered) return 'No orders match these filters';
  if (filter === 'today') return 'No orders uploaded today';
  if (filter === 'yesterday') return 'No orders uploaded yesterday';
  if (filter === 'all') return 'No orders yet';
  return 'No orders uploaded on these days';
}

/** "Invoiced", "2 of 3 invoiced" or "Not invoiced". */
export function invoiceSummary({ invoicedLines = 0, lineCount = 0 }) {
  if (lineCount > 0 && invoicedLines === lineCount) return { label: 'Invoiced', tone: 'good' };
  if (invoicedLines > 0) return { label: `${invoicedLines} of ${lineCount} invoiced`, tone: 'warn' };
  return { label: 'Not invoiced', tone: 'warn' };
}
