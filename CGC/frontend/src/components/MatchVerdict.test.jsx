import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
