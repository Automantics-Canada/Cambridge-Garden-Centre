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

/** The note under a line whose agreed rate is missing: for a haul, dispatch sets it. */
export function missingRateText(item) {
  return isHaulLine(item) ? 'No haul rate set by dispatch for this load.' : 'No agreed rate on file for this product.';
}
