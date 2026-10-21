import { describe, expect, it } from 'vitest';

import { aiCheckBadge, aiOnlyNote, dateWarning, flagInfo, processState, slotStatus, summaryLine } from './spruceImport';
import { assignWarning } from './dispatchBoard';

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

  it('counts the deliveries the upload put on the dispatch board, whatever their dates', () => {
    expect(summaryLine({ deliveries: 0, upcoming: 0, onBoard: 13, pickups: 6, dispatchDate: '2026-10-18' }))
      .toBe('13 deliveries on the dispatch board, 6 pickups.');
    expect(summaryLine({ deliveries: 0, upcoming: 0, onBoard: 1, pickups: 1, updated: 2, dispatchDate: '2026-10-18' }))
      .toBe('1 delivery on the dispatch board, 1 pickup, 2 updated.');
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

describe('the AI double-check', () => {
  const check = (status, ordersDiffering = 0) => ({ reportType: 'DELIVERY', status, ordersDiffering });

  it('says in one badge how the double-check of the whole upload went', () => {
    expect(aiCheckBadge({ aiChecks: [check('agreed'), check('agreed')] })).toEqual({ tone: 'good', label: 'AI double-check agreed' });
    expect(aiCheckBadge({ aiChecks: [check('agreed'), check('differences', 2), check('differences', 1)] }))
      .toEqual({ tone: 'warn', label: 'AI double-check: 3 orders read differently' });
    expect(aiCheckBadge({ aiChecks: [check('differences', 1)] })).toEqual({ tone: 'warn', label: 'AI double-check: 1 order read differently' });
    expect(aiCheckBadge({ aiChecks: [check('agreed'), check('unavailable')] }))
      .toEqual({ tone: 'neutral', label: 'AI double-check did not finish' });
  });

  it('shows no badge where no double-check ran', () => {
    expect(aiCheckBadge({})).toBeNull();
    expect(aiCheckBadge({ aiChecks: [] })).toBeNull();
  });

  it('says who read a report only when something unusual happened', () => {
    expect(aiOnlyNote({ readByAi: true })).toBeNull();
    expect(aiOnlyNote({ readByAi: false })).toBeNull();
    expect(aiOnlyNote({ readByAi: false, aiFailed: 'the AI account is out of credit' }))
      .toBe('The AI could not read this report (the AI account is out of credit), so the report reader read it. Check its orders before dispatch.');
    expect(aiOnlyNote({ readByAi: true, readByAiBecause: 'its layout was not recognised' }))
      .toBe('Read by AI alone, because its layout was not recognised. Check its orders before dispatch.');
  });

  it('names the flag, and asks before giving such an order to a driver', () => {
    expect(flagInfo('READ_DIFFERENTLY')).toEqual({ label: 'AI read it differently: check', tone: 'warn' });
    expect(assignWarning({ spruceOrderId: '2610-720652', flags: ['READ_DIFFERENTLY'] }))
      .toBe('2610-720652: AI read it differently: check. Assign anyway?');
  });
});
