import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  plannedLinks,
  primaryCopy,
  ticketCopyKey,
  withinCopyWindow,
  type CopyCandidate,
} from '../src/modules/tickets/ticketCopies.js';

/** Which copy of a load counts. Pure; the database side is ticketCopies.integration.test.ts. */

const copy = (id: string, source: 'MANUAL' | 'EMAIL' | 'WHATSAPP', receivedAt: string, over: Partial<CopyCandidate> = {}): CopyCandidate => ({
  id, source, supplierId: 'sup-1', ticketNumber: 'T-501', ticketDate: null,
  receivedAt: new Date(receivedAt), duplicateOfTicketId: null, poNumber: '482913', ...over,
});

describe('ticketCopyKey', () => {
  it('compares letters and digits only, and refuses numbers too short to identify a load', () => {
    assert.equal(ticketCopyKey('T-501'), 't501');
    assert.equal(ticketCopyKey('#t 501'), 't501');
    assert.equal(ticketCopyKey('12'), null);
    assert.equal(ticketCopyKey(null), null);
  });
});

describe('primaryCopy', () => {
  it("prefers the driver's copy over the supplier's emailed one, whichever came first", () => {
    const emailed = copy('e', 'EMAIL', '2026-10-01T08:00:00Z');
    const driver = copy('d', 'MANUAL', '2026-10-01T15:00:00Z');
    assert.equal(primaryCopy([emailed, driver]).id, 'd');
    assert.equal(primaryCopy([driver, emailed]).id, 'd');
  });

  it('between two copies of the same kind, the earlier one', () => {
    assert.equal(primaryCopy([copy('b', 'MANUAL', '2026-10-02'), copy('a', 'WHATSAPP', '2026-10-01')]).id, 'a');
  });
});

describe('plannedLinks', () => {
  it('every other copy points straight at the one that counts', () => {
    const plan = plannedLinks([
      copy('e1', 'EMAIL', '2026-10-01'),
      copy('d', 'MANUAL', '2026-10-03'),
      copy('e2', 'EMAIL', '2026-10-02', { duplicateOfTicketId: 'e1' }),
    ]);
    assert.deepEqual(Object.fromEntries(plan), { e1: 'd', d: null, e2: 'd' });
  });

  it('a ticket on its own points at nothing', () => {
    assert.deepEqual(Object.fromEntries(plannedLinks([copy('d', 'MANUAL', '2026-10-01', { duplicateOfTicketId: 'gone' })])), { d: null });
  });
});

describe('withinCopyWindow', () => {
  it('a missing date does not stop a link; dates far apart do', () => {
    assert.equal(withinCopyWindow(null, new Date('2026-01-01')), true);
    assert.equal(withinCopyWindow(new Date('2026-01-01'), new Date('2026-03-01')), true);
    assert.equal(withinCopyWindow(new Date('2025-01-01'), new Date('2026-01-01')), false);
  });
});
