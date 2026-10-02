/**
 * The morning import's rules, kept apart from the screen so they can be tested.
 *
 * Three Spruce reports, each in its own slot, read as they are dropped in and
 * imported together. The Delivery Report is the one that cannot be missing:
 * it is the list of what goes out today.
 */

export const REPORT_SLOTS = [
  { type: 'ORDER_SUMMARY', step: 1, label: 'Order Report', spruceTitle: 'Customer Order Summary' },
  { type: 'DELIVERY', step: 2, label: 'Delivery Report', spruceTitle: 'Deliveries' },
  { type: 'ITEM_TRACKING', step: 3, label: 'Item Tracking Report', spruceTitle: 'Sales Order Item Tracking' },
];

export const slotFor = (type) => REPORT_SLOTS.find((slot) => slot.type === type);

/** Every flag the import can raise, in words a dispatcher uses. */
export const ORDER_FLAG_INFO = {
  NO_ADDRESS: { label: 'No address', tone: 'bad' },
  CHECK_ADDRESS: { label: 'Check address', tone: 'warn' },
  DATE_MISMATCH: { label: 'Date mismatch', tone: 'warn' },
  TOTAL_MISMATCH: { label: 'Total mismatch', tone: 'warn' },
  EXTRACTION_CHECK_FAILED: { label: 'Prices need checking', tone: 'warn' },
  NOT_IN_LATEST_REPORT: { label: 'Not in latest report', tone: 'warn' },
  AWAITING_SUPPLIER: { label: 'Awaiting supplier', tone: 'neutral' },
  SMALL_TRUCK: { label: 'Small truck', tone: 'neutral' },
  CUSTOMER_ON_SITE: { label: 'Customer on site', tone: 'neutral' },
  NOT_OPEN: { label: 'No longer open', tone: 'neutral' },
};

export const flagInfo = (flag) => ORDER_FLAG_INFO[flag] ?? { label: flag, tone: 'neutral' };

/** `2026-08-14` → `8/14`, as the yard writes a day. */
export function shortDay(isoDate) {
  if (!isoDate) return '';
  const [, month, day] = isoDate.split('-').map(Number);
  return `${month}/${day}`;
}

/**
 * Where a dropped file stands in its slot.
 *
 * `wrongSlot` keeps the file and names the slot it belongs in, so one click
 * moves it there instead of choosing it again.
 */
export function slotStatus(slotType, preview) {
  if (!preview) return { kind: 'empty' };
  if (preview.error) return { kind: 'error', message: preview.error };
  if (preview.reportType !== slotType) {
    const belongs = slotFor(preview.reportType);
    return {
      kind: 'wrongSlot',
      belongsIn: preview.reportType,
      message: `This looks like the ${belongs?.label ?? 'another report'}.`,
    };
  }
  return { kind: 'ready' };
}

/** A warning when the report was filtered on other days than the one being dispatched. */
export function dateWarning(preview, dispatchDate) {
  if (!preview?.dateFrom || !preview?.dateTo || !dispatchDate) return null;
  if (dispatchDate >= preview.dateFrom && dispatchDate <= preview.dateTo) return null;
  const span = preview.dateFrom === preview.dateTo
    ? shortDay(preview.dateFrom)
    : `${shortDay(preview.dateFrom)}–${shortDay(preview.dateTo)}`;
  return `This report is for ${span}, not ${shortDay(dispatchDate)}.`;
}

/**
 * Whether the reports can be imported, and what the button should say.
 *
 * All three ready, or two when the Delivery Report is one of them — with the
 * missing report named, because what it carries will not be refreshed.
 */
export function processState(previews) {
  const statuses = REPORT_SLOTS.map((slot) => ({ slot, status: slotStatus(slot.type, previews[slot.type]) }));
  const blocked = statuses.some(({ status }) => status.kind === 'error' || status.kind === 'wrongSlot');
  const ready = statuses.filter(({ status }) => status.kind === 'ready').map(({ slot }) => slot);
  const missing = REPORT_SLOTS.filter((slot) => !ready.includes(slot));
  const hasDelivery = ready.some((slot) => slot.type === 'DELIVERY');

  if (blocked) return { canProcess: false, label: 'Process reports', reason: 'Fix the reports marked above first.' };
  if (!hasDelivery) {
    return { canProcess: false, label: 'Process reports', reason: 'The Delivery Report is needed: it is the list of what goes out.' };
  }
  if (missing.length === 0) return { canProcess: true, label: 'Process reports', reason: null };
  if (missing.length === 1) {
    return {
      canProcess: true,
      label: 'Process with 2 of 3',
      reason: `Without the ${missing[0].label}, ${MISSING_EFFECT[missing[0].type]}`,
    };
  }
  return { canProcess: true, label: 'Process the Delivery Report only', reason: 'Prices, addresses and instructions will not be refreshed.' };
}

const MISSING_EFFECT = {
  ORDER_SUMMARY: 'prices, totals and the scheduled-delivery flag will not be refreshed.',
  ITEM_TRACKING: 'addresses, delivery instructions and supplier POs will not be refreshed.',
};

/** "16 deliveries for 8/14, 3 upcoming, 5 pickups." */
export function summaryLine(summary) {
  const deliveries = `${summary.deliveries} ${summary.deliveries === 1 ? 'delivery' : 'deliveries'}`;
  const pickups = `${summary.pickups} ${summary.pickups === 1 ? 'pickup' : 'pickups'}`;
  return `${deliveries} for ${shortDay(summary.dispatchDate)}, ${summary.upcoming} upcoming, ${pickups}.`;
}
