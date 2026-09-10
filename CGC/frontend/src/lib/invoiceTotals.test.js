import { describe, expect, it } from 'vitest';
import { summariseInvoiceApproval } from './invoiceTotals';

const line = (overrides = {}) => ({
  quantity: 10,
  unitRate: 20,
  negotiatedRate: 18,
  ...overrides,
});

describe('summariseInvoiceApproval', () => {
  it('approves an invoice whose every line has an agreed rate', () => {
    const result = summariseInvoiceApproval([line(), line({ quantity: 5 })], 305.1);

    // (10 x 18) + (5 x 18) = 270, plus 13% HST = 305.10
    expect(result.canApprove).toBe(true);
    expect(result.approvedTotal).toBeCloseTo(305.1, 2);
    expect(result.discrepancy).toBeCloseTo(0, 2);
  });

  it('refuses to state an amount when a line has no agreed rate', () => {
    // The bug this replaces: the missing rate fell back to the supplier's own
    // billed rate, so the screen showed the supplier's figure as CGC's approved
    // amount, with a discrepancy of about zero.
    const result = summariseInvoiceApproval(
      [line(), line({ negotiatedRate: null })],
      400
    );

    expect(result.canApprove).toBe(false);
    expect(result.approvedTotal).toBeNull();
    expect(result.discrepancy).toBeNull();
    expect(result.unpricedCount).toBe(1);
    expect(result.lineCount).toBe(2);
  });

  it('never uses the billed rate as a substitute', () => {
    const result = summariseInvoiceApproval([line({ negotiatedRate: null, unitRate: 99 })], 1118.7);

    expect(result.approvedTotal).toBeNull();
    expect(result.canApprove).toBe(false);
  });

  it('treats undefined the same as missing', () => {
    const result = summariseInvoiceApproval([line({ negotiatedRate: undefined })], 100);
    expect(result.canApprove).toBe(false);
  });

  it('treats a zero rate as a real agreed rate', () => {
    // A waived delivery charge is agreed at zero. Truthiness would have read it
    // as "no rate on file" and blocked an otherwise complete invoice.
    const result = summariseInvoiceApproval(
      [line({ quantity: 1, negotiatedRate: 0 })],
      0
    );

    expect(result.canApprove).toBe(true);
    expect(result.approvedTotal).toBeCloseTo(0, 2);
  });

  it('reports a real discrepancy when the supplier billed more than agreed', () => {
    // 10 x 18 = 180, +13% = 203.40. Supplier billed 250.
    const result = summariseInvoiceApproval([line()], 250);

    expect(result.canApprove).toBe(true);
    expect(result.discrepancy).toBeCloseTo(46.6, 2);
  });

  it('has nothing to approve on an invoice with no lines read yet', () => {
    expect(summariseInvoiceApproval([], 100).canApprove).toBe(false);
    expect(summariseInvoiceApproval(undefined, 100).canApprove).toBe(false);
    expect(summariseInvoiceApproval(null, 100).approvedTotal).toBeNull();
  });

  it('counts a missing quantity as nothing delivered, not as a guess', () => {
    const result = summariseInvoiceApproval([line({ quantity: null })], 0);
    expect(result.canApprove).toBe(true);
    expect(result.approvedTotal).toBeCloseTo(0, 2);
  });
});
