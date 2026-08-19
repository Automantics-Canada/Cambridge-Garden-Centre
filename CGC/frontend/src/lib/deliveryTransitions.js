/**
 * The delivery state machine, as the UI needs to know it.
 *
 * This mirrors `CGC/backend/src/modules/deliveries/deliveryTransitions.ts`. The
 * server has enforced these rules since the state machine landed, but both
 * status dropdowns still offered a flat Placed / In Transit / Delivered list
 * regardless of where the delivery actually was. Two things went wrong as a
 * result:
 *
 *   1. A delivery sitting in UNASSIGNED was not among the three options, so the
 *      browser showed "Placed" as selected. The control misreported the state
 *      before anyone touched it, and picking In Transit asked the server for
 *      UNASSIGNED -> IN_TRANSIT, which it correctly refused with a 409.
 *   2. The refusal came back with a precise explanation, which the page threw
 *      away in favour of "Failed to update status".
 *
 * Keeping a copy here rather than fetching the legal moves per record is a
 * deliberate trade: it is two tables that can drift, guarded by
 * `deliveryTransitions.test.js`, instead of a schema and API change. If this
 * list ever needs to vary per record, move it onto the delivery payload.
 */

export const DELIVERY_TRANSITIONS = {
  UNASSIGNED: ['PLACED', 'CANCELLED'],
  PLACED: ['UNASSIGNED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'DELAYED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['IN_TRANSIT', 'ON_HOLD', 'DELAYED', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'ON_HOLD', 'DELAYED', 'CANCELLED'],
  ON_HOLD: ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'DELAYED', 'CANCELLED'],
  DELAYED: ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** States from which nothing may move. */
export const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'];

/** Statuses a DRIVER may set on its own delivery. */
export const DRIVER_ALLOWED_TARGETS = [
  'OUT_FOR_DELIVERY',
  'IN_TRANSIT',
  'DELIVERED',
  'ON_HOLD',
  'DELAYED',
];

/**
 * Evidence the server requires before a state can be entered.
 * DELIVERED is the proof-of-delivery gate — completing a stop without a photo
 * would put an unbacked record into the invoice-matching chain.
 */
export const REQUIRED_EVIDENCE = {
  DELIVERED: 'deliveryPhotoUrl',
};

export const STATUS_LABELS = {
  UNASSIGNED: 'Unassigned',
  PLACED: 'Placed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  IN_TRANSIT: 'In transit',
  ON_HOLD: 'On hold',
  DELAYED: 'Delayed',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || 'Unknown';
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Options for a status dropdown on a given delivery.
 *
 * Always includes the current status first, so the control shows what the
 * delivery is rather than defaulting to whatever happens to be listed first.
 * An option is `disabled` when the server would refuse it, with `reason`
 * carrying the explanation — a delivery that cannot be completed because nobody
 * has uploaded a photo should say so, not fail silently on submit.
 */
export function statusOptionsFor(delivery, { role } = {}) {
  const current = delivery?.status;
  const options = [
    { value: current, label: statusLabel(current), disabled: false, current: true },
  ];

  if (isTerminal(current)) return options;

  for (const target of DELIVERY_TRANSITIONS[current] || []) {
    let reason = null;

    if (role === 'DRIVER' && !DRIVER_ALLOWED_TARGETS.includes(target)) {
      continue;
    }

    const requiredField = REQUIRED_EVIDENCE[target];
    if (requiredField && !delivery?.[requiredField]) {
      reason =
        requiredField === 'deliveryPhotoUrl'
          ? 'Needs a delivery photo first'
          : `Needs ${requiredField}`;
    }

    options.push({
      value: target,
      label: reason ? `${statusLabel(target)} — ${reason}` : statusLabel(target),
      disabled: Boolean(reason),
      reason,
      current: false,
    });
  }

  return options;
}

/**
 * The sentence to show when a status change is refused.
 * The server sends a specific reason; showing "Failed to update status" instead
 * is what left the tester with nothing to act on.
 */
export function statusErrorMessage(error) {
  return (
    error?.response?.data?.error ||
    error?.message ||
    'Failed to update status'
  );
}
