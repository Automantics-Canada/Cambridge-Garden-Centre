import { describe, expect, it } from 'vitest';
import { decideReviewCommit, reviewValuesFromTicket } from './ticketReviewForm';

describe('reviewValuesFromTicket', () => {
  it('prefers the linked supplier name over the free-text one', () => {
    const values = reviewValuesFromTicket({
      supplier: { name: 'Cambridge Aggregates' },
      supplierName: 'cambrige aggregets',
    });
    expect(values.supplierName).toBe('Cambridge Aggregates');
  });

  it('renders the date as the yyyy-mm-dd a date input needs', () => {
    const values = reviewValuesFromTicket({ ticketDate: '2026-08-14T09:30:00.000Z' });
    expect(values.ticketDate).toBe('2026-08-14');
  });

  it('turns every absent field into an empty string, never undefined', () => {
    // An undefined value would make the input uncontrolled again, which is the
    // whole class of bug being fixed here.
    const values = reviewValuesFromTicket(null);
    Object.values(values).forEach((value) => {
      expect(value).toBe('');
    });
  });

  it('keeps a zero quantity rather than blanking it', () => {
    expect(reviewValuesFromTicket({ quantity: 0 }).quantity).toBe(0);
  });
});

describe('decideReviewCommit', () => {
  it('writes nothing when the value is untouched', () => {
    // The reported bug: focusing a field and clicking away saved the ticket and
    // showed "Ticket updated" with nothing changed.
    expect(decideReviewCommit('material', 'Screened topsoil', 'Screened topsoil'))
      .toEqual({ action: 'none' });
  });

  it('writes nothing when a number is retyped identically', () => {
    // The form holds strings; the ticket holds a number. Comparing them loosely
    // is what stops a no-op blur on the quantity field from saving.
    expect(decideReviewCommit('quantity', '12.5', 12.5)).toEqual({ action: 'none' });
  });

  it('saves a genuine text change', () => {
    expect(decideReviewCommit('poNumber', 'PO-4471', 'PO-4470'))
      .toEqual({ action: 'save', value: 'PO-4471' });
  });

  it('saves quantity as a number, not the input string', () => {
    expect(decideReviewCommit('quantity', '18.25', 12)).toEqual({ action: 'save', value: 18.25 });
  });

  it('refuses to persist NaN when the quantity is cleared', () => {
    const result = decideReviewCommit('quantity', '', 12);
    expect(result.action).toBe('revert');
    expect(result.value).toBe(12);
    expect(result.message).toMatch(/number/i);
  });

  it('refuses to persist NaN for unparseable text', () => {
    expect(decideReviewCommit('quantity', 'abc', 12).action).toBe('revert');
  });

  it('refuses to persist an empty ticket date', () => {
    const result = decideReviewCommit('ticketDate', '', '2026-08-14');
    expect(result).toEqual({ action: 'revert', value: '2026-08-14' });
  });

  it('still saves a real date change', () => {
    expect(decideReviewCommit('ticketDate', '2026-08-15', '2026-08-14'))
      .toEqual({ action: 'save', value: '2026-08-15' });
  });

  it('allows text fields to be cleared deliberately', () => {
    // Unlike quantity and date, an empty PO number is a legitimate value.
    expect(decideReviewCommit('poNumber', '', 'PO-4470'))
      .toEqual({ action: 'save', value: '' });
  });
});
