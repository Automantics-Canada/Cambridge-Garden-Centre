/**
 * A trucking invoice line and the dispatch loads it was checked against
 * (client, Oct 2026, Q14: "the dispatcher sets the rate for each load
 * dispatched and it is matched up when the invoice comes in").
 *
 * The invoice page gets `haulLoads` on each line from the office invoice API;
 * nothing here ever reaches a driver. Kept out of the page so the wording can
 * be tested.
 */
import { formatHaulRate } from './haulLoads';

/** Whether the line was checked as a haul: it carries the loads it bills. */
export function isHaulLine(item) {
  return Array.isArray(item?.haulLoads) && item.haulLoads.length > 0;
}

/**
 * One row per matched load, as the page lists them: the order and load
 * number, who hauled it, the rate dispatch set and its unit, and the trip
 * when one brokered truck served several orders.
 */
export function haulLoadRows(item) {
  const loads = Array.isArray(item?.haulLoads) ? item.haulLoads : [];
  return loads.map((load) => ({
    id: load.id,
    order: `Order ${load.documentNumber}`,
    load: `Load ${load.sequence}`,
    carrier: load.carrierName || 'Carrier not recorded',
    rate: formatHaulRate(load.rate, load.rateUnit) || 'No rate set',
    trip: load.tripRef ? `Trip ${load.tripRef}` : '',
    ticket: load.ticketNumber ? `Ticket ${load.ticketNumber}` : '',
  }));
}

/**
 * Whether the line was checked as a trucking line at all, even when no load
 * was found for it: its verdict carries the haul checks.
 */
function checkedAsHaul(item) {
  const evidence = item?.matchResult?.evidence;
  return Array.isArray(evidence) && evidence.some((check) => check?.name === 'haulLoad');
}

/**
 * The note under a line whose agreed rate is missing. For a haul the rate is
 * the one dispatch sets on the load, so the note says where to look: on the
 * load, or for the load itself when none was found.
 */
export function missingRateText(item) {
  if (isHaulLine(item)) return 'No haul rate set by dispatch for this load.';
  if (checkedAsHaul(item)) return 'No dispatched load found, so there is no haul rate to check against.';
  return 'No agreed rate on file for this product.';
}
