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

/**
 * The "Awaiting supplier" badge with who and which PO, as the spec words it:
 * "Awaiting supplier: Unilock PO 2608-355356". Several POs are joined. Just
 * "Awaiting supplier" when the order names none.
 */
export function awaitingSupplierText(order) {
  const label = flagInfo('AWAITING_SUPPLIER').label;
  const named = (order?.awaitingSupplier ?? [])
    .map(({ supplierName, poNumber }) => [supplierName, poNumber && `PO ${poNumber}`].filter(Boolean).join(' '))
    .filter(Boolean);
  return named.length > 0 ? `${label}: ${named.join(', ')}` : label;
}

/** What a flag's badge says on this order. */
export function flagLabel(order, flag) {
  return flag === 'AWAITING_SUPPLIER' ? awaitingSupplierText(order) : flagInfo(flag).label;
}

/** Badges for an order's flags, the ones needing attention first. */
export function flagBadges(order) {
  const flags = order?.flags ?? [];
  const first = flags.filter((flag) => ASSIGN_WARNING_FLAGS.includes(flag));
  const rest = flags.filter((flag) => !ASSIGN_WARNING_FLAGS.includes(flag));
  return [...first, ...rest].map((flag) => ({ flag, ...flagInfo(flag), label: flagLabel(order, flag) }));
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

/** What each field Spruce can change is called on the screens. */
export const CHANGE_FIELD_LABELS = {
  customerName: 'Customer',
  phone: 'Phone',
  route: 'Route',
  shippingAddress: 'Delivery address',
  deliveryInstructions: 'Delivery instructions',
  deliveryTruck: 'Truck needed',
  deliveryDate: 'Delivery date',
  deliveryType: 'Delivery type',
  product: 'Item description',
  quantity: 'Quantity',
  lineAdded: 'Item added',
  lineRemoved: 'Item removed',
};

export const changeFieldLabel = (field) => CHANGE_FIELD_LABELS[field] ?? field;

/**
 * The hover text of an order's "Updated" badge: which fields today's upload
 * changed. Null when it changed none, and the badge is not shown.
 */
export function updatedTitle(order) {
  const fields = order?.updatedFields ?? [];
  if (fields.length === 0) return null;
  return `Changed by today's upload: ${fields.map(changeFieldLabel).join(', ')}`;
}
