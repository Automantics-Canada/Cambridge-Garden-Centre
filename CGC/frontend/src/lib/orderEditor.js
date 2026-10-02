/**
 * The edit screen's rules, kept apart from it so they can be tested.
 *
 * A dispatcher corrects what Spruce left incomplete. Only the fields that
 * actually changed are sent, so opening an order and saving it untouched
 * creates no corrections.
 */

export const ORDER_FIELDS = [
  { key: 'customerName', label: 'Customer' },
  { key: 'phone', label: 'Phone' },
  { key: 'shippingAddress', label: 'Delivery address' },
  { key: 'deliveryInstructions', label: 'Delivery instructions', multiline: true },
  { key: 'deliveryDate', label: 'Delivery date', type: 'date' },
  { key: 'deliveryType', label: 'Delivery type', type: 'deliveryType' },
  { key: 'deliveryTruck', label: 'Truck needed' },
];

export const DELIVERY_TYPE_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: 'SLINGER', label: 'Slinger' },
  { value: 'SPLITBOX', label: 'Splitbox' },
  { value: 'FLATBED', label: 'Flatbed' },
  { value: 'DUMP', label: 'Dump' },
  { value: 'BAG', label: 'Bag delivery' },
  { value: 'GENERAL', label: 'Delivery' },
];

/** A date from the API (`2026-08-14T00:00:00.000Z`) as the date input wants it. */
const dayOf = (value) => (value ? String(value).slice(0, 10) : '');

/** What a quantity looks like in the form: no trailing zeros. */
const quantityText = (value) => (value === null || value === undefined ? '' : String(Number(value)));

export function formFromOrder(order) {
  const fields = {};
  for (const { key, type } of ORDER_FIELDS) {
    fields[key] = type === 'date' ? dayOf(order[key]) : order[key] ?? '';
  }
  return {
    fields,
    lines: Object.fromEntries((order.lines ?? []).map((line) => [
      line.id,
      { product: line.product ?? '', quantity: quantityText(line.quantity) },
    ])),
    dispatcherNotes: order.dispatcherNotes ?? '',
  };
}

const same = (a, b) => (a ?? '').trim() === (b ?? '').trim();

/**
 * The request for what changed between the order and the form, or null when
 * nothing did.
 */
export function editRequest(order, form) {
  const original = formFromOrder(order);
  const request = {};

  const fields = {};
  for (const { key } of ORDER_FIELDS) {
    if (!same(form.fields[key], original.fields[key])) fields[key] = form.fields[key];
  }
  if (Object.keys(fields).length > 0) request.fields = fields;

  const lines = [];
  for (const [id, values] of Object.entries(form.lines)) {
    const before = original.lines[id];
    if (!before) continue;
    const changed = {};
    if (!same(values.product, before.product)) changed.product = values.product;
    if (!same(values.quantity, before.quantity)) changed.quantity = values.quantity;
    if (Object.keys(changed).length > 0) lines.push({ id, ...changed });
  }
  if (lines.length > 0) request.lines = lines;

  if (!same(form.dispatcherNotes, original.dispatcherNotes)) request.dispatcherNotes = form.dispatcherNotes;

  return Object.keys(request).length > 0 ? request : null;
}

/** The correction on a field, if it has one. `lineId` null for the order's own. */
export function overrideFor(order, field, lineId = null) {
  return (order?.overrides ?? []).find((override) => override.field === field && (override.lineId ?? null) === lineId) ?? null;
}

/** How Spruce's value reads beside a correction: "nothing" rather than blank. */
export function spruceText(override, field) {
  const value = override?.spruceValue;
  if (value === null || value === undefined || value === '') return 'nothing';
  if (field === 'deliveryType') return DELIVERY_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value;
  return value;
}
