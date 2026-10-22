import { describe, expect, it } from 'vitest';

import { flagBadges } from './dispatchBoard';
import { externalStatus, FULFILMENT_LABELS, fulfilmentType, routeLine, undatedText } from './fulfilment';
import { deliveryStatusView, pastDueWithoutDriver } from './orderList';

/** The spec's acceptance checks, on the Oct 21, 2026 orders as the server describes them. */

const place = (name, location = null, po = null) => ({ name, location, address: null, po });
const order = (type, places = [], checks = [], extra = {}) => ({
  isPickup: type === 'yard_pickup' || type === 'external_pickup',
  flags: [],
  fulfilment: { type, places, signal: null, checks },
  ...extra,
});

describe('fulfilment display (the manager\'s acceptance checks)', () => {
  it('1. 721461: Supplier pickup, no date, nothing missing, "Pickup at Permacon"', () => {
    const o = order('external_pickup', [place('Permacon')]);
    expect(FULFILMENT_LABELS[fulfilmentType(o)]).toBe('Supplier pickup');
    expect(undatedText(o)).toBe('—');
    expect(flagBadges(o)).toEqual([]);
    expect(deliveryStatusView(o).label).toBe('Pickup at Permacon');
  });

  it('2. 721436: "Pickup at Unilock Ayr", and neither "Awaiting supplier" nor "Pickup at yard"', () => {
    const o = order('external_pickup', [place('Unilock', 'Ayr', '2610-357347')], [], { flags: ['AWAITING_SUPPLIER'] });
    expect(deliveryStatusView(o).label).toBe('Pickup at Unilock Ayr');
    expect(flagBadges(o)).toEqual([]);
  });

  it('3. 721522: Direct ship, "Unilock delivers to site", "Set by Unilock", "No supplier PO yet"; no "No longer open" or "No driver yet"', () => {
    const o = order('supplier_direct_ship', [place('Unilock')], ['NO_SUPPLIER_PO_YET', 'NOT_IN_ORDER_REPORT'], { flags: ['NOT_OPEN'] });
    expect(FULFILMENT_LABELS[fulfilmentType(o)]).toBe('Direct ship');
    expect(externalStatus(o)).toBe('Unilock delivers to site');
    expect(deliveryStatusView(o).label).toBe('Unilock delivers to site');
    expect(undatedText(o)).toBe('Set by Unilock');
    expect(flagBadges(o).map((badge) => badge.label)).toEqual(['No supplier PO yet', 'Not in Order report']);
    expect(pastDueWithoutDriver({ ...o, deliveryDate: '2026-10-01' }, '2026-10-22')).toBe(false);
  });

  it('4. 721443: Delivery via supplier, past due with no driver, "Collect at Willson Cambridge → deliver to site"', () => {
    const o = order('supplier_haul_delivery', [place('Willson', 'Cambridge', '2610-357348')], [], {
      flags: ['AWAITING_SUPPLIER'], deliveryDate: '2026-10-21', delivery: null,
    });
    expect(FULFILMENT_LABELS[fulfilmentType(o)]).toBe('Delivery via supplier');
    expect(routeLine(o)).toBe('Collect at Willson Cambridge → deliver to site');
    expect(deliveryStatusView(o).label).toBe('No driver yet');
    expect(pastDueWithoutDriver(o, '2026-10-22')).toBe(true);
    expect(flagBadges(o)).toEqual([], 'the route line replaces "Awaiting supplier"');
  });

  it('5. 721425 and 721427: the vendor code until it is in the vendor map', () => {
    expect(routeLine(order('supplier_haul_delivery', [place('GALTGRAV01', null, '2610-357344')]))).toBe('Collect at GALTGRAV01 → deliver to site');
    expect(routeLine(order('supplier_haul_delivery', [place('ALSSTONE01', 'Cambridge', '2610-357345')])))
      .toBe('Collect at ALSSTONE01 Cambridge → deliver to site');
  });

  it('6. 721420: "Collect at pit (not named)", "No supplier PO", "Supplier not named"', () => {
    const o = order('supplier_haul_delivery', [place(null)], ['NO_SUPPLIER_PO', 'SUPPLIER_NOT_NAMED']);
    expect(routeLine(o)).toBe('Collect at pit (not named) → deliver to site');
    expect(flagBadges(o).map((badge) => badge.label)).toEqual(['No supplier PO', 'Supplier not named']);
  });

  it('8 and 9. yard deliveries stay "Delivery", yard pickups stay "Pickup at yard"', () => {
    expect(FULFILMENT_LABELS[fulfilmentType(order('yard_delivery'))]).toBe('Delivery');
    expect(routeLine(order('yard_delivery'))).toBeNull();
    expect(deliveryStatusView(order('yard_pickup')).label).toBe('Pickup at yard');
  });

  it('721442 and 721493: a delivery read from its charge alone asks staff to confirm', () => {
    const o = order('yard_delivery', [], ['CHECK_DELIVERY_OR_PICKUP']);
    expect(FULFILMENT_LABELS[fulfilmentType(o)]).toBe('Delivery');
    expect(flagBadges(o).map((badge) => badge.label)).toEqual(['Delivery or pickup? Confirm']);
  });

  it('13. an external order also on the CGC schedule keeps its type and says so', () => {
    const o = order('external_pickup', [place('Permacon')], ['ON_CGC_DELIVERY_SCHEDULE']);
    expect(FULFILMENT_LABELS[fulfilmentType(o)]).toBe('Supplier pickup');
    expect(flagBadges(o).map((badge) => badge.label)).toEqual(['On CGC delivery schedule']);
  });

  it('falls back to what the import decided for an answer without a type', () => {
    expect(fulfilmentType({ isPickup: true })).toBe('yard_pickup');
    expect(fulfilmentType({ isPickup: false })).toBe('yard_delivery');
  });
});
