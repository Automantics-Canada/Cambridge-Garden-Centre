import { describe, expect, it } from 'vitest';
import { deliveryStatusView, deliveryTypeDetail, emptyTitle, invoiceSummary, pastDueWithoutDriver, uploadRange } from './orderList';

const days = { today: '2026-10-05', yesterday: '2026-10-04' };

describe('uploadRange', () => {
  it('asks for one day for Today and Yesterday', () => {
    expect(uploadRange({ ...days, filter: 'today' })).toEqual({ uploadStartDate: '2026-10-05', uploadEndDate: '2026-10-05' });
    expect(uploadRange({ ...days, filter: 'yesterday' })).toEqual({ uploadStartDate: '2026-10-04', uploadEndDate: '2026-10-04' });
  });

  it('asks for no dates at all for All', () => {
    expect(uploadRange({ ...days, filter: 'all' })).toEqual({});
  });

  it('takes a range, one end as one day, and a backwards range as the days between', () => {
    expect(uploadRange({ ...days, filter: 'range', from: '2026-10-07', to: '2026-10-10' }))
      .toEqual({ uploadStartDate: '2026-10-07', uploadEndDate: '2026-10-10' });
    expect(uploadRange({ ...days, filter: 'range', from: '2026-10-07', to: '' }))
      .toEqual({ uploadStartDate: '2026-10-07', uploadEndDate: '2026-10-07' });
    expect(uploadRange({ ...days, filter: 'range', from: '2026-10-10', to: '2026-10-07' }))
      .toEqual({ uploadStartDate: '2026-10-07', uploadEndDate: '2026-10-10' });
  });

  it('fetches nothing until a range has a day', () => {
    expect(uploadRange({ ...days, filter: 'range', from: '', to: '' })).toBeNull();
  });
});

describe('deliveryStatusView', () => {
  it('says a pickup is collected at the yard', () => {
    expect(deliveryStatusView({ isPickup: true }).label).toBe('Pickup at yard');
  });

  it('says no driver for an order never assigned or taken back', () => {
    expect(deliveryStatusView({ delivery: null }).label).toBe('No driver yet');
    expect(deliveryStatusView({ delivery: { status: 'UNASSIGNED', driverName: null } }).label).toBe('No driver yet');
  });

  it('names the driver and how far the stop has got', () => {
    expect(deliveryStatusView({ delivery: { status: 'PLACED', driverName: 'Alex' } })).toEqual({ label: 'With driver', tone: 'neutral', detail: 'Alex' });
    expect(deliveryStatusView({ delivery: { status: 'IN_TRANSIT', driverName: 'Alex' } }).label).toBe('On the way');
    expect(deliveryStatusView({ delivery: { status: 'DELIVERED', driverName: 'Alex' } }).tone).toBe('good');
  });
});

describe('emptyTitle', () => {
  it('asks for days before a range is chosen, and blames filters when there are any', () => {
    expect(emptyTitle({ filter: 'range', from: '', to: '' })).toBe('Pick the days');
    expect(emptyTitle({ filter: 'today', filtered: true })).toBe('No orders match these filters');
    expect(emptyTitle({ filter: 'today' })).toBe('No orders uploaded today');
  });
});

describe('invoiceSummary', () => {
  it('counts invoiced lines', () => {
    expect(invoiceSummary({ invoicedLines: 3, lineCount: 3 }).label).toBe('Invoiced');
    expect(invoiceSummary({ invoicedLines: 1, lineCount: 3 }).label).toBe('1 of 3 invoiced');
    expect(invoiceSummary({ invoicedLines: 0, lineCount: 3 }).label).toBe('Not invoiced');
  });
});

describe('past due with no driver', () => {
  const TODAY = '2026-10-18';
  const delivery = (overrides = {}) => ({
    isPickup: false,
    deliveryDate: '2026-10-13T00:00:00.000Z',
    delivery: null,
    flags: [],
    ...overrides,
  });

  it('flags a delivery dated before today that nobody has been given', () => {
    // 2608-711248: due 13/10, uploaded 18/10, still "No driver yet".
    expect(pastDueWithoutDriver(delivery(), TODAY)).toBe(true);
    // Given a driver and taken back off: still waiting.
    expect(pastDueWithoutDriver(delivery({ delivery: { status: 'PLACED', driverName: null } }), TODAY)).toBe(true);
  });

  it('leaves alone what is due today or later, has a driver, or is finished', () => {
    expect(pastDueWithoutDriver(delivery({ deliveryDate: '2026-10-18T00:00:00.000Z' }), TODAY)).toBe(false);
    expect(pastDueWithoutDriver(delivery({ deliveryDate: '2026-10-20T00:00:00.000Z' }), TODAY)).toBe(false);
    expect(pastDueWithoutDriver(delivery({ delivery: { status: 'PLACED', driverName: 'Jane Doe' } }), TODAY)).toBe(false);
    expect(pastDueWithoutDriver(delivery({ delivery: { status: 'DELIVERED', driverName: null } }), TODAY)).toBe(false);
  });

  it('never flags pickups, undated orders, or orders Spruce has closed', () => {
    expect(pastDueWithoutDriver(delivery({ isPickup: true }), TODAY)).toBe(false);
    expect(pastDueWithoutDriver(delivery({ deliveryDate: null }), TODAY)).toBe(false);
    expect(pastDueWithoutDriver(delivery({ flags: ['NOT_OPEN'] }), TODAY)).toBe(false);
  });
});

describe('deliveryTypeDetail', () => {
  it('names how a delivery goes out under its Delivery badge', () => {
    expect(deliveryTypeDetail({ isPickup: false, deliveryType: 'FLATBED' })).toBe('Flatbed');
    expect(deliveryTypeDetail({ isPickup: false, deliveryType: 'BAG' })).toBe('Bag delivery');
  });

  it('says nothing for a plain delivery, which would read "Delivery Delivery"', () => {
    // 2610-721058 and 2610-721522 on 21/10/2026.
    expect(deliveryTypeDetail({ isPickup: false, deliveryType: 'GENERAL' })).toBeNull();
  });

  it('says nothing for a pickup or an order with no type', () => {
    expect(deliveryTypeDetail({ isPickup: true, deliveryType: 'FLATBED' })).toBeNull();
    expect(deliveryTypeDetail({ isPickup: false, deliveryType: null })).toBeNull();
  });
});
