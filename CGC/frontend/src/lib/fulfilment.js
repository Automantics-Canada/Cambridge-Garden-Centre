/**
 * How an order's goods reach the customer, as the screens say it. The server
 * decides the type (backend/src/modules/dispatch/fulfilment.ts); these are the
 * display rules of the manager's spec of 22/10/2026, "Order Fulfilment Types".
 */

export const FULFILMENT_LABELS = {
  yard_pickup: 'Pickup',
  yard_delivery: 'Delivery',
  supplier_haul_delivery: 'Delivery via supplier',
  external_pickup: 'Supplier pickup',
  supplier_direct_ship: 'Direct ship',
};

/** The type, falling back to what the import decided for an answer without one. */
export const fulfilmentType = (order) =>
  order?.fulfilment?.type ?? (order?.isPickup ? 'yard_pickup' : 'yard_delivery');

/** The customer collects (at the yard or a supplier): no CGC truck, no stop. */
export const isCollected = (order) => ['yard_pickup', 'external_pickup'].includes(fulfilmentType(order));

/** A supplier moves the goods to the customer: no CGC driver ever. */
export const isExternal = (order) => ['external_pickup', 'supplier_direct_ship'].includes(fulfilmentType(order));

const placeName = (place) => [place?.name, place?.location].filter(Boolean).join(' ');

/**
 * The status that replaces the driver status for an external order: "Pickup at
 * Unilock Ayr", "Unilock delivers to site". Null for the other types.
 */
export function externalStatus(order) {
  const type = fulfilmentType(order);
  const place = order?.fulfilment?.places?.[0];
  if (type === 'external_pickup') return `Pickup at ${placeName(place) || 'supplier'}`;
  if (type === 'supplier_direct_ship') return `${place?.name || 'Supplier'} delivers to site`;
  return null;
}

/**
 * Where a CGC truck collects before delivering: "Collect at Willson Cambridge →
 * deliver to site", or the pit nobody named. Null for the other types.
 */
export function routeLine(order) {
  if (fulfilmentType(order) !== 'supplier_haul_delivery') return null;
  const places = order?.fulfilment?.places ?? [];
  if (places.length === 0) return null;
  return places
    .map((place) => `Collect at ${place.name ? placeName(place) : 'pit (not named)'} → deliver to site`)
    .join('; ');
}

/** The checks the type raises, in the dispatcher's words. */
export const FULFILMENT_CHECKS = {
  ON_CGC_DELIVERY_SCHEDULE: { label: 'On CGC delivery schedule', tone: 'warn' },
  SUPPLIER_NOT_NAMED: { label: 'Supplier not named', tone: 'warn' },
  NO_SUPPLIER_PO: { label: 'No supplier PO', tone: 'warn' },
  NO_SUPPLIER_PO_YET: { label: 'No supplier PO yet', tone: 'warn' },
  NOT_IN_ORDER_REPORT: { label: 'Not in Order report', tone: 'neutral' },
  PICKUP_AND_DIRECT_BOTH_NOTED: { label: 'Pickup and direct delivery both noted', tone: 'warn' },
  CHECK_PICKUP_POINT: { label: 'Check pickup point', tone: 'warn' },
};

/**
 * Stored flags that do not apply to the type. An external pickup's ship-to is
 * a note, not a site, so its address and phone checks go; the PO on an
 * external order is the pickup authorisation, not stock CGC waits on; a
 * delivery via a supplier says where to collect instead of "Awaiting
 * supplier"; and a direct ship missing from the Order report is not "No
 * longer open" but "Not in Order report".
 */
const HIDDEN_FLAGS = {
  external_pickup: ['AWAITING_SUPPLIER', 'NO_ADDRESS', 'NOT_IN_ITEM_TRACKING', 'CHECK_ADDRESS', 'NO_PHONE', 'NOT_OPEN'],
  supplier_direct_ship: ['AWAITING_SUPPLIER', 'NOT_OPEN'],
  supplier_haul_delivery: ['AWAITING_SUPPLIER'],
};

export const flagApplies = (order, flag) => !(HIDDEN_FLAGS[fulfilmentType(order)] ?? []).includes(flag);

/** The type's own checks, as badges. */
export const fulfilmentCheckBadges = (order) =>
  (order?.fulfilment?.checks ?? []).map((check) => ({ flag: check, ...(FULFILMENT_CHECKS[check] ?? { label: check, tone: 'neutral' }) }));

/**
 * The delivery-date cell when the order has no date: nothing for a pickup,
 * "Set by Unilock" for a direct ship (the supplier books it), and null where
 * the missing date is a problem worth showing in red.
 */
export function undatedText(order) {
  const type = fulfilmentType(order);
  if (type === 'yard_pickup' || type === 'external_pickup') return '—';
  if (type === 'supplier_direct_ship') return `Set by ${order?.fulfilment?.places?.[0]?.name || 'supplier'}`;
  return null;
}
