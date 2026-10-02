import { describe, expect, it } from 'vitest';

import { dateWarning, flagInfo, processState, slotStatus, summaryLine } from './spruceImport';

const ready = (reportType, extra = {}) => ({ reportType, dateFrom: '2026-08-14', dateTo: '2026-08-14', ...extra });

describe('slotStatus', () => {
  it('offers to move a report dropped into the wrong slot', () => {
    expect(slotStatus('ORDER_SUMMARY', ready('DELIVERY'))).toEqual({
      kind: 'wrongSlot',
      belongsIn: 'DELIVERY',
      message: 'This looks like the Delivery Report.',
    });
  });

  it('reports a file that could not be read', () => {
    expect(slotStatus('DELIVERY', { error: 'Not a Spruce report' })).toEqual({ kind: 'error', message: 'Not a Spruce report' });
  });
});

describe('processState', () => {
  const all = { ORDER_SUMMARY: ready('ORDER_SUMMARY'), DELIVERY: ready('DELIVERY'), ITEM_TRACKING: ready('ITEM_TRACKING') };

  it('processes all three', () => {
    expect(processState(all)).toMatchObject({ canProcess: true, label: 'Process reports', reason: null });
  });

  it('allows two of three only when the Delivery Report is one, and says what is lost', () => {
    const noTracking = { ...all, ITEM_TRACKING: undefined };
    expect(processState(noTracking)).toMatchObject({ canProcess: true, label: 'Process with 2 of 3' });
    expect(processState(noTracking).reason).toMatch(/addresses/);

    expect(processState({ ...all, DELIVERY: undefined }).canProcess).toBe(false);
  });

  it('waits while any report is in the wrong slot or unreadable', () => {
    expect(processState({ ...all, ORDER_SUMMARY: ready('ITEM_TRACKING') }).canProcess).toBe(false);
    expect(processState({ ...all, ITEM_TRACKING: { error: 'bad' } }).canProcess).toBe(false);
  });
});

describe('dateWarning', () => {
  it('warns when a report covers other days than the one being dispatched', () => {
    expect(dateWarning(ready('DELIVERY', { dateFrom: '2026-08-13', dateTo: '2026-08-13' }), '2026-08-14'))
      .toBe('This report is for 8/13, not 8/14.');
    expect(dateWarning(ready('DELIVERY'), '2026-08-14')).toBeNull();
  });
});

describe('wording', () => {
  it('summarises the day the way the yard says it', () => {
    expect(summaryLine({ deliveries: 16, upcoming: 3, pickups: 5, dispatchDate: '2026-08-14' }))
      .toBe('16 deliveries for 8/14, 3 upcoming, 5 pickups.');
    expect(summaryLine({ deliveries: 1, upcoming: 0, pickups: 1, dispatchDate: '2026-08-14' }))
      .toBe('1 delivery for 8/14, 0 upcoming, 1 pickup.');
  });

  it('counts the orders a later upload changed, when there are any', () => {
    expect(summaryLine({ deliveries: 16, upcoming: 3, pickups: 5, updated: 2, dispatchDate: '2026-08-14' }))
      .toBe('16 deliveries for 8/14, 3 upcoming, 5 pickups, 2 updated.');
    expect(summaryLine({ deliveries: 16, upcoming: 3, pickups: 5, updated: 0, dispatchDate: '2026-08-14' }))
      .toBe('16 deliveries for 8/14, 3 upcoming, 5 pickups.');
  });

  it('names every flag, and an unknown one by its code rather than not at all', () => {
    expect(flagInfo('NO_ADDRESS')).toEqual({ label: 'No address', tone: 'bad' });
    expect(flagInfo('SOMETHING_NEW')).toEqual({ label: 'SOMETHING_NEW', tone: 'neutral' });
  });
});
