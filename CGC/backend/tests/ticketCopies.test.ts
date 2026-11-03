import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  copyGroup,
  plannedLinks,
  primaryCopy,
  sameLoadCopies,
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

describe('sameLoadCopies', () => {
  const driver = copy('d', 'MANUAL', '2026-10-01T08:00:00Z', { supplierId: null });
  const emailed = copy('e', 'EMAIL', '2026-10-02T08:00:00Z');

  it('same supplier is a copy whatever the PO says (the engine flags a PO that disagrees)', () => {
    assert.deepEqual(sameLoadCopies(emailed, [copy('x', 'MANUAL', '2026-10-01T08:00:00Z', { poNumber: '777777' })]).map((c) => c.id), ['x']);
  });

  it("a driver photo whose supplier could not be read is linked when the PO agrees, from either side", () => {
    // Left apart, the engine counted the load twice: the blank-supplier copy
    // is still counted for the line.
    assert.deepEqual(sameLoadCopies(emailed, [driver]).map((c) => c.id), ['d']);
    assert.deepEqual(sameLoadCopies(driver, [emailed]).map((c) => c.id), ['e']);
    assert.deepEqual(sameLoadCopies(emailed, [{ ...driver, poNumber: '2608-482913' }]).map((c) => c.id), ['d']);
  });

  it('but not when the PO differs or is missing, nor across two different suppliers', () => {
    assert.deepEqual(sameLoadCopies(emailed, [{ ...driver, poNumber: '777777' }]), []);
    assert.deepEqual(sameLoadCopies(emailed, [{ ...driver, poNumber: null }]), []);
    assert.deepEqual(sameLoadCopies(driver, [emailed, copy('o', 'EMAIL', '2026-10-02T08:00:00Z', { supplierId: 'sup-2' })]), []);
  });

  it('a different supplier with the same number is never a copy', () => {
    assert.deepEqual(sameLoadCopies(emailed, [copy('o', 'MANUAL', '2026-10-01T08:00:00Z', { supplierId: 'sup-2' })]), []);
  });
});

describe('copyGroup', () => {
  const ids = (group: CopyCandidate[]) => group.map((c) => c.id).sort();

  it('a matched copy brings the copies it is grouped with, so no chain is left', () => {
    const y = copy('y', 'EMAIL', '2026-10-01', { poNumber: '300' });
    const x = copy('x', 'EMAIL', '2026-10-02', { poNumber: '200', duplicateOfTicketId: 'y' });
    const z = copy('z', 'MANUAL', '2026-10-03', { poNumber: '300', supplierId: null });
    const group = copyGroup(z, [y], [x, y]);
    assert.deepEqual(ids(group), ['x', 'y', 'z']);
    assert.deepEqual([...plannedLinks(group)].sort(), [['x', 'z'], ['y', 'z'], ['z', null]]);
  });

  it('and the copy it pointed at', () => {
    const x = copy('x', 'EMAIL', '2026-10-01', { poNumber: '300' });
    const y = copy('y', 'EMAIL', '2026-10-02', { poNumber: '200', duplicateOfTicketId: 'x' });
    const z = copy('z', 'MANUAL', '2026-10-03', { poNumber: '200', supplierId: null });
    assert.deepEqual(ids(copyGroup(z, [y], [x])), ['x', 'y', 'z']);
  });

  it("leaves out a family of another supplier's copies, and joins nothing a blank ticket would bridge", () => {
    const blank = copy('b', 'MANUAL', '2026-10-01', { supplierId: null });
    const theirs = copy('t', 'EMAIL', '2026-10-02', { supplierId: 'sup-2', duplicateOfTicketId: 'b' });
    const mine = copy('m', 'EMAIL', '2026-10-03');
    assert.deepEqual(ids(copyGroup(mine, [blank], [theirs])), ['m']);

    const other = copy('o', 'EMAIL', '2026-10-04');
    assert.deepEqual(ids(copyGroup(blank, [theirs, other], [])), ['b']);
  });

  it("a copy already under this ticket keeps no old family of its own", () => {
    const d = copy('d', 'MANUAL', '2026-10-01');
    const e = copy('e', 'EMAIL', '2026-10-02', { duplicateOfTicketId: 'd' });
    assert.deepEqual(ids(copyGroup(d, [e], [])), ['d', 'e']);
  });
});
