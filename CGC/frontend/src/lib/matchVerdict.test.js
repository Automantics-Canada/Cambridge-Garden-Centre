import { describe, expect, it } from 'vitest';
import {
  bySeverity,
  checkTally,
  checkTitle,
  describeVerdict,
  needsAttention,
  orderedChecks,
} from './matchVerdict';

const verdict = (overrides = {}) => ({
  status: 'MATCHED',
  reason: 'Every check passed',
  evidence: [],
  resolution: null,
  ...overrides,
});

describe('describeVerdict', () => {
  it('gives each status its own words and tone', () => {
    expect(describeVerdict(verdict({ status: 'MATCHED' })).tone).toBe('good');
    expect(describeVerdict(verdict({ status: 'PARTIAL' })).tone).toBe('warn');
    expect(describeVerdict(verdict({ status: 'CONFLICT' })).tone).toBe('bad');
    expect(describeVerdict(verdict({ status: 'UNMATCHED' })).tone).toBe('neutral');
  });

  it('never presents anything but MATCHED as good', () => {
    // The badge this replaces was green on a value nothing had computed. No
    // status other than a real pass may look like one.
    for (const status of ['PARTIAL', 'UNMATCHED', 'CONFLICT']) {
      expect(describeVerdict(verdict({ status })).tone).not.toBe('good');
    }
  });

  it('treats a missing verdict as unchecked, not as a pass', () => {
    // A line nothing has looked at must not be indistinguishable from one that
    // cleared every check.
    for (const value of [null, undefined, {}, { status: null }]) {
      const described = describeVerdict(value);
      expect(described.tone).not.toBe('good');
      expect(described.label).toBe('Not checked yet');
    }
  });

  it('falls back safely on a status it does not know', () => {
    // A future status must not render as a pass just because it is unfamiliar.
    const described = describeVerdict(verdict({ status: 'SOMETHING_NEW' }));
    expect(described.tone).not.toBe('good');
  });
});

describe('orderedChecks', () => {
  it('puts failures first, because that is what the reader came for', () => {
    const ordered = orderedChecks(
      verdict({
        evidence: [
          { name: 'po', passed: true, detail: 'ok' },
          { name: 'quantity', passed: false, detail: 'short' },
          { name: 'rate', passed: true, detail: 'ok' },
        ],
      })
    );
    expect(ordered[0].name).toBe('quantity');
  });

  it('copes with missing or malformed evidence', () => {
    expect(orderedChecks(null)).toEqual([]);
    expect(orderedChecks(verdict({ evidence: undefined }))).toEqual([]);
    expect(orderedChecks(verdict({ evidence: 'not an array' }))).toEqual([]);
  });

  it('does not mutate the stored evidence', () => {
    const result = verdict({
      evidence: [
        { name: 'po', passed: true, detail: 'ok' },
        { name: 'quantity', passed: false, detail: 'short' },
      ],
    });
    orderedChecks(result);
    expect(result.evidence[0].name).toBe('po');
  });
});

describe('checkTally', () => {
  it('counts passes and failures', () => {
    const tally = checkTally(
      verdict({
        evidence: [
          { name: 'po', passed: true },
          { name: 'quantity', passed: false },
          { name: 'rate', passed: false },
        ],
      })
    );
    expect(tally).toEqual({ total: 3, failed: 2, passed: 1 });
  });

  it('is zero for a verdict with no evidence', () => {
    expect(checkTally(null)).toEqual({ total: 0, failed: 0, passed: 0 });
  });
});

describe('needsAttention', () => {
  it('an unevaluated line needs a person', () => {
    expect(needsAttention(null)).toBe(true);
  });

  it('a matched line does not', () => {
    expect(needsAttention(verdict({ status: 'MATCHED' }))).toBe(false);
  });

  it('a partial or conflicting line does', () => {
    expect(needsAttention(verdict({ status: 'PARTIAL' }))).toBe(true);
    expect(needsAttention(verdict({ status: 'CONFLICT' }))).toBe(true);
  });

  it('stops nagging once a person has resolved it', () => {
    // Someone looked at the discrepancy and accepted it. Continuing to flag it
    // teaches people to ignore the screen.
    expect(needsAttention(verdict({ status: 'PARTIAL', resolution: 'CONFIRMED' }))).toBe(false);
  });
});

describe('bySeverity', () => {
  it('sorts the lines that need a person to the top', () => {
    const lines = [
      { id: 'a', matchResult: { status: 'MATCHED' } },
      { id: 'b', matchResult: { status: 'CONFLICT' } },
      { id: 'c', matchResult: { status: 'PARTIAL' } },
      { id: 'd', matchResult: { status: 'UNMATCHED' } },
    ];
    expect([...lines].sort(bySeverity).map((line) => line.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('never sorts an unevaluated line above a real problem', () => {
    const lines = [
      { id: 'unevaluated' },
      { id: 'conflict', matchResult: { status: 'CONFLICT' } },
      { id: 'matched', matchResult: { status: 'MATCHED' } },
    ];
    const sorted = [...lines].sort(bySeverity).map((line) => line.id);
    expect(sorted[0]).toBe('conflict');
    expect(sorted[sorted.length - 1]).toBe('matched');
  });
});

describe('checkTitle', () => {
  it('uses words a person reading an invoice would use', () => {
    expect(checkTitle('ticketCoverage')).toBe('Delivery tickets');
    expect(checkTitle('po')).toBe('Purchase order');
    expect(checkTitle('rate')).toBe('Rate');
  });

  it('passes through anything it does not know rather than hiding it', () => {
    expect(checkTitle('somethingNew')).toBe('somethingNew');
  });
});
