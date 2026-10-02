import { flagInfo } from './spruceImport';

export function mergeUnassignedOrders(unassignedOrders = [], unassignedDeliveries = []) {
  const ordersById = new Map();

  for (const order of unassignedOrders) {
    if (order?.id) ordersById.set(order.id, order);
  }

  for (const delivery of unassignedDeliveries) {
    const order = delivery?.order;
    if (order?.id && !ordersById.has(order.id)) {
      ordersById.set(order.id, order);
    }
  }

  return [...ordersById.values()];
}

/**
 * How the dispatch routes name a row: a whole Spruce order by its id, or —
 * for a stop made before orders were dispatched whole — the single line.
 */
export function orderRef(order) {
  return order?.wholeOrder ? { documentId: order.id } : { orderId: order?.id };
}

/** Flags that mean an order may not be ready to go out as it is. */
export const ASSIGN_WARNING_FLAGS = [
  'NO_ADDRESS',
  'CHECK_ADDRESS',
  'DATE_MISMATCH',
  'TOTAL_MISMATCH',
  'EXTRACTION_CHECK_FAILED',
  'NOT_IN_LATEST_REPORT',
];

/**
 * The question to ask before giving a flagged order to a driver, or null.
 * A warning, never a block: the dispatcher may know the address already.
 */
export function assignWarning(order) {
  const problems = (order?.flags ?? []).filter((flag) => ASSIGN_WARNING_FLAGS.includes(flag));
  if (problems.length === 0) return null;
  const named = problems.map((flag) => flagInfo(flag).label).join(', ');
  return `${order.spruceOrderId}: ${named}. Assign anyway?`;
}

/** Badges for an order's flags, the ones needing attention first. */
export function flagBadges(order) {
  const flags = order?.flags ?? [];
  const first = flags.filter((flag) => ASSIGN_WARNING_FLAGS.includes(flag));
  const rest = flags.filter((flag) => !ASSIGN_WARNING_FLAGS.includes(flag));
  return [...first, ...rest].map((flag) => ({ flag, ...flagInfo(flag) }));
}

const DELIVERY_TYPE_LABELS = {
  SLINGER: 'Slinger',
  SPLITBOX: 'Splitbox',
  FLATBED: 'Flatbed',
  DUMP: 'Dump',
  BAG: 'Bag delivery',
  GENERAL: 'Delivery',
};

export const deliveryTypeLabel = (type) => (type ? DELIVERY_TYPE_LABELS[type] ?? type : null);

/**
 * What a delivery list shows for a stop: its whole Spruce order where it has
 * one — order number, first product and how many more, the total where the
 * products share a unit — and the single line it names otherwise.
 */
export function stopSummary(delivery) {
  const document = delivery?.document;
  if (!document) return delivery?.order ?? {};

  const products = (document.lines ?? []).filter((line) => !line.lineClass || line.lineClass === 'PRODUCT');
  const first = products[0];
  const units = new Set(products.map((line) => line.unit ?? ''));
  const sharedUnit = units.size === 1 && first?.unit ? first.unit : null;

  return {
    spruceOrderId: document.documentNumber,
    customerName: document.customerName,
    product: first
      ? products.length > 1 ? `${first.product} +${products.length - 1} more` : first.product
      : 'No products listed',
    quantity: sharedUnit
      ? products.reduce((sum, line) => sum + Number(line.quantity ?? 0), 0)
      : first?.quantity ?? null,
    unit: sharedUnit ?? first?.unit ?? null,
  };
}
