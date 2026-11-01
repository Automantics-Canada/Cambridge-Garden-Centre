/**
 * The Orders page's rules, kept apart from the screen so they can be tested.
 * Every day is a 'YYYY-MM-DD' calendar date in the yard's timezone.
 */
import { deliveryTypeLabel } from './dispatchBoard';
import { externalStatus, fulfilmentType, isCollected, isExternal } from './fulfilment';
import { deliveryDay } from './dispatchDays';

/**
 * How an order goes out, shown under its Delivery badge: "Flatbed",
 * "Splitbox". Null for a pickup, and for a plain delivery, whose label is
 * "Delivery" and would only repeat the badge above it.
 */
export function deliveryTypeDetail(order) {
  if (!order || isCollected(order) || isExternal(order) || order.deliveryType === 'GENERAL') return null;
  return deliveryTypeLabel(order.deliveryType);
}

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

/**
 * Orders, or the Quotations view. A quotation is a price given to a customer
 * in Spruce, not an order; the list leaves them out unless asked.
 */
export const QUOTE_OPTIONS = [
  { value: '', label: 'Orders' },
  { value: 'only', label: 'Quotations' },
];

/**
 * What an order is missing. Phone lists deliveries that were on a Deliveries
 * report with no phone: the only report that prints one.
 */
export const MISSING_OPTIONS = [
  // Not "Anything": that reads as orders missing anything at all.
  { value: '', label: 'No filter' },
  { value: 'phone', label: 'Phone' },
];

const isQuotation = (order) => (order?.flags ?? []).includes('QUOTE');

const STARTED = ['OUT_FOR_DELIVERY', 'IN_TRANSIT'];

/**
 * Where an order stands, for its status badge: what to say, its tone, and the
 * driver's name under it. A pickup is collected at the yard and never gets a
 * stop, so it says so rather than "No driver". A quotation is going nowhere,
 * so it says what it is.
 */
export function deliveryStatusView(order) {
  if (isQuotation(order)) return { label: 'Quotation', tone: 'neutral', detail: null };
  const external = externalStatus(order);
  if (external) return { label: external, tone: 'neutral', detail: null };
  if (fulfilmentType(order) === 'yard_pickup') return { label: `Pickup at ${order?.collectAt || 'yard'}`, tone: 'neutral', detail: null };
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
 * A delivery whose day has gone by and that still has no driver: it either
 * went out without the system hearing of it, or needs a new day. Pickups
 * never get a driver, and an order Spruce has closed is waiting for nothing.
 *
 * @param today 'YYYY-MM-DD' in the yard's timezone
 */
export function pastDueWithoutDriver(order, today) {
  if (!order || isCollected(order) || isExternal(order) || !today) return false;
  // A quotation is not an order, so nothing about it is overdue.
  if ((order.flags ?? []).some(flag => flag === 'NOT_OPEN' || flag === 'QUOTE')) return false;
  const due = deliveryDay(order.deliveryDate);
  if (!due || due >= today) return false;
  return deliveryStatusView(order).label === 'No driver yet';
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

/** The empty list's heading, for what was asked: orders, or quotations. */
export function emptyTitle({ filter, from, to, filtered, quotations = false }) {
  const things = quotations ? 'quotations' : 'orders';
  if (filter === 'range' && !from && !to) return 'Pick the days';
  if (filtered) return `No ${things} match these filters`;
  if (filter === 'today') return `No ${things} uploaded today`;
  if (filter === 'yesterday') return `No ${things} uploaded yesterday`;
  if (filter === 'all') return `No ${things} yet`;
  return `No ${things} uploaded on these days`;
}

/** What the list's count is counting: "order", "orders", "quotations". */
export function countNoun(total, { quotations = false } = {}) {
  return `${quotations ? 'quotation' : 'order'}${total === 1 ? '' : 's'}`;
}

/** "Invoiced", "2 of 3 invoiced" or "Not invoiced". */
export function invoiceSummary({ invoicedLines = 0, lineCount = 0 }) {
  if (lineCount > 0 && invoicedLines === lineCount) return { label: 'Invoiced', tone: 'good' };
  if (invoicedLines > 0) return { label: `${invoicedLines} of ${lineCount} invoiced`, tone: 'warn' };
  return { label: 'Not invoiced', tone: 'warn' };
}
