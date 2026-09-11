import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MatchVerdict from './MatchVerdict';

afterEach(cleanup);

const withEvidence = {
  status: 'PARTIAL',
  reason: 'Billed at 21.4 against an agreed 18 per tonnes, 18.9% above the 1% allowed',
  evidence: [
    { name: 'po', passed: true, detail: 'PO 482913 matches 1 order line' },
    {
      name: 'rate',
      passed: false,
      detail: 'Billed at 21.4 against an agreed 18 per tonnes',
      expected: 18,
      found: 21.4,
      delta: 3.4,
    },
  ],
};

describe('match verdict', () => {
  it('shows the status and the reason without being opened', () => {
    render(<MatchVerdict matchResult={withEvidence} />);
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.getByText(/18\.9% above/)).toBeTruthy();
  });

  it('says how many checks failed', () => {
    render(<MatchVerdict matchResult={withEvidence} />);
    expect(screen.getByText('1 of 2 checks failed')).toBeTruthy();
  });

  it('keeps the evidence one click away, and shows the numbers', () => {
    render(<MatchVerdict matchResult={withEvidence} />);

    // Collapsed to begin with: the desk lists many lines at once.
    expect(screen.queryByText('Rate')).toBeNull();

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Rate')).toBeTruthy();
    expect(screen.getByText('Purchase order')).toBeTruthy();
    expect(screen.getByText(/expected/)).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('21.4')).toBeTruthy();
  });

  it('lists the failed check before the one that passed', () => {
    render(<MatchVerdict matchResult={withEvidence} />);
    fireEvent.click(screen.getByRole('button'));

    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Rate');
  });

  it('an unevaluated line does not read as a pass', () => {
    // The failure this whole panel exists to prevent.
    render(<MatchVerdict matchResult={null} />);
    expect(screen.getByText('Not checked yet')).toBeTruthy();
    expect(screen.queryByText('Matched')).toBeNull();
  });

  it('cannot be expanded when there is no evidence to show', () => {
    render(<MatchVerdict matchResult={null} />);
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  });

  it('says who resolved a verdict, when someone has', () => {
    render(
      <MatchVerdict
        matchResult={{
          ...withEvidence,
          resolution: 'CONFIRMED',
          resolvedBy: { id: 'u1', name: 'Sarah' },
        }}
      />
    );
    expect(screen.getByText(/Resolved by Sarah/)).toBeTruthy();
  });

  it('renders a matched line as passed', () => {
    render(
      <MatchVerdict
        matchResult={{
          status: 'MATCHED',
          reason: 'Every check passed',
          evidence: [{ name: 'po', passed: true, detail: 'PO matches' }],
        }}
      />
    );
    expect(screen.getByText('Matched')).toBeTruthy();
    expect(screen.getByText('1 check passed')).toBeTruthy();
  });

  it('tells a screen reader whether each check passed', () => {
    render(<MatchVerdict matchResult={withEvidence} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('passed')).toBeTruthy();
  });
});

describe('recording a decision', () => {
  const conflict = {
    id: 'mr-1',
    status: 'CONFLICT',
    reason: '2 orders fit this ticket equally well; a person must choose',
    candidateOrderIds: ['order-a', 'order-b'],
    evidence: [{ name: 'po', passed: true, detail: 'PO 482913 matches 2 order lines' }],
  };

  it('offers no decision buttons when the screen cannot act on them', () => {
    // Read-only contexts pass no handler; the panel must not imply an action
    // that will not happen.
    render(<MatchVerdict matchResult={conflict} />);
    expect(screen.queryByText('Confirm')).toBeNull();
  });

  it('confirms without demanding a reason', () => {
    // Confirming agrees with reasoning that is already stored.
    const onResolve = vi.fn();
    render(<MatchVerdict matchResult={conflict} onResolve={onResolve} />);

    fireEvent.click(screen.getByText('Confirm'));
    fireEvent.click(screen.getByText('Record decision'));

    expect(onResolve).toHaveBeenCalledWith({
      resolution: 'CONFIRMED',
      orderId: undefined,
      note: undefined,
    });
  });

  it('will not submit an override until an order and a reason are given', () => {
    const onResolve = vi.fn();
    render(<MatchVerdict matchResult={conflict} onResolve={onResolve} />);

    fireEvent.click(screen.getByText('Different order'));
    const submit = screen.getByText('Record decision');
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'order-b' } });
    expect(screen.getByText('Record decision').hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Checked with the yard.' },
    });
    fireEvent.click(screen.getByText('Record decision'));

    expect(onResolve).toHaveBeenCalledWith({
      resolution: 'OVERRIDDEN',
      orderId: 'order-b',
      note: 'Checked with the yard.',
    });
  });

  it('offers the conflicting orders as the choice, rather than free text', () => {
    render(<MatchVerdict matchResult={conflict} onResolve={vi.fn()} />);
    fireEvent.click(screen.getByText('Different order'));

    const options = screen.getAllByRole('option').map((option) => option.value);
    expect(options).toContain('order-a');
    expect(options).toContain('order-b');
  });

  it('will not submit a rejection without a reason', () => {
    const onResolve = vi.fn();
    render(<MatchVerdict matchResult={conflict} onResolve={onResolve} />);

    fireEvent.click(screen.getByText('Reject'));
    fireEvent.click(screen.getByText('Record decision'));
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('shows a settled verdict as settled, and offers to reopen it', () => {
    const onReopen = vi.fn();
    render(
      <MatchVerdict
        matchResult={{ ...conflict, resolution: 'OVERRIDDEN', resolutionNote: 'Second order.' }}
        onResolve={vi.fn()}
        onReopen={onReopen}
      />
    );

    expect(screen.getByText(/Second order\./)).toBeTruthy();
    expect(screen.queryByText('Confirm')).toBeNull();

    fireEvent.click(screen.getByText('Reopen'));
    expect(onReopen).toHaveBeenCalled();
  });
});
