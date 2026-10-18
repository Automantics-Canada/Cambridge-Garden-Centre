/**
 * What a driver needs from the stop in hand, and nothing about money.
 *
 * A stop delivers a whole Spruce order: the customer, where to go, who to
 * call, what is on the truck, and what dispatch wants them to know. An order
 * bought in from a supplier also says where to load it first and the PO to
 * quote there; one from CGC's own yard has no such pickup. A stop
 * made before orders were dispatched whole only names one line, and is shown
 * as that line, as it always was.
 */

const DELIVERY_TYPE_LABELS = {
  SLINGER: 'Slinger',
  SPLITBOX: 'Splitbox',
  FLATBED: 'Flatbed',
  DUMP: 'Dump',
  BAG: 'Bag delivery',
  GENERAL: 'Delivery',
};

/** Where to load first: each supplier, its address where known, and the PO to quote. */
const pickupsOf = (delivery) =>
  (delivery?.pickupFrom ?? []).map(({ name, location, address, po }) => ({
    name: name || null,
    location: location || null,
    address: address || null,
    po,
  }));

/**
 * What goes on the truck, with repeated loads of one item in one line:
 * six 40 MT lines of the same aggregate read "240 MT, 6 loads".
 */
function truckLines(lines) {
  const grouped = new Map();
  for (const line of lines.filter(onTheTruck)) {
    const key = `${(line.spruceItemNumber || line.product || '').toUpperCase()}|${line.unit ?? ''}`;
    const seen = grouped.get(key);
    if (seen) {
      seen.quantity = Number((Number(seen.quantity ?? 0) + Number(line.quantity ?? 0)).toFixed(4));
      seen.loads += 1;
    } else {
      grouped.set(key, { product: line.product, quantity: line.quantity, unit: line.unit, loads: 1 });
    }
  }
  return [...grouped.values()].map(({ loads, ...line }) => (loads > 1 ? { ...line, loads } : line));
}

/** Lines that go on the truck: not delivery charges, deposits or comments. */
const onTheTruck = (line) => !line.lineClass || line.lineClass === 'PRODUCT';

export function stopView(delivery) {
  const document = delivery?.document;
  const order = delivery?.order ?? {};

  if (!document) {
    return {
      orderNumber: order.spruceOrderId ?? '',
      customerName: order.customerName ?? '',
      phone: null,
      address: order.shippingAddress || order.document?.shippingAddress || '',
      instructions: null,
      notes: null,
      deliveryType: null,
      lines: order.product ? [{ product: order.product, quantity: order.quantity, unit: order.unit }] : [],
      skids: 0,
      pickups: pickupsOf(delivery),
    };
  }

  const lines = document.lines ?? [];
  return {
    orderNumber: document.documentNumber,
    customerName: document.customerName,
    phone: document.phone || null,
    address: document.addressNormalized || document.shippingAddress || '',
    instructions: document.deliveryInstructions || null,
    notes: document.dispatcherNotes || null,
    deliveryType: document.deliveryType ? DELIVERY_TYPE_LABELS[document.deliveryType] ?? document.deliveryType : null,
    lines: truckLines(lines),
    skids: lines
      .filter((line) => line.lineClass === 'DEPOSIT')
      .reduce((sum, line) => sum + Number(line.quantity ?? 0), 0),
    pickups: pickupsOf(delivery),
  };
}

/** A phone number as a `tel:` link: digits only, the extension dialled after a pause. */
export function telHref(phone) {
  if (!phone) return null;
  const [number, extension] = phone.split(/\s*ext\.?\s*/i);
  const digits = number.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return `tel:${digits}${extension ? `,${extension.replace(/\D/g, '')}` : ''}`;
}
