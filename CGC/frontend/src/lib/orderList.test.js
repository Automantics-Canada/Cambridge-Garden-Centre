import { describe, expect, it } from 'vitest';
import { deliveryStatusView, emptyTitle, invoiceSummary, uploadRange } from './orderList';

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
