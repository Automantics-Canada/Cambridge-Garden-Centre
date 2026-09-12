import './setupEnv.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { explain } from '../src/modules/matching/matching.routes.js';

/**
 * What a clerk is told when a resolution is refused.
 *
 * Two of these refusals are the point of the duplicate-billing work, and both
 * carry a sentence naming the ticket, the invoice it already paid and who
 * confirmed it. That sentence has to survive the trip to the screen. It did not
 * at first: the codes were missing from the mapping and fell through to "That
 * resolution could not be applied", which tells a person nothing and invites
 * them to pay the invoice outside the system instead.
 */

describe('refusal messages', () => {
  it('passes the reuse detail through untouched', () => {
    const detail =
      'Ticket 88213 (24.6 tonnes) was already used to pay invoice INV-1001 line 1, ' +
      'confirmed by Jane. Paying this line would pay for that load twice.';

    const { status, error } = explain({ ok: false, code: 'TICKETS_ALREADY_CLAIMED', detail });

    assert.equal(status, 409);
    assert.equal(error, detail, 'the clerk must be told which load, and where it went');
  });

  it('keeps the contention detail and asks for a reason', () => {
    const detail = 'Invoice INV-1007 also bills PO 482913 and has not been reviewed.';

    const { status, error } = explain({ ok: false, code: 'NOTE_REQUIRED_DUPLICATE', detail });

    assert.equal(status, 400);
    assert.match(error, /INV-1007/);
    assert.match(error, /why/i);
  });

  it('never reports a refusal as success', () => {
    const codes = [
      { ok: false as const, code: 'NOT_FOUND' as const },
      { ok: false as const, code: 'ORDER_REQUIRED' as const },
      { ok: false as const, code: 'NOTE_REQUIRED' as const },
      { ok: false as const, code: 'ORDER_NOT_FOUND' as const },
      { ok: false as const, code: 'ALREADY_RESOLVED' as const, resolvedAt: new Date() },
    ];

    for (const outcome of codes) {
      const { status, error } = explain(outcome);
      assert.ok(status >= 400, `${outcome.code} must not be a success status`);
      assert.ok(error.length > 0, `${outcome.code} must say something`);
    }
  });
});
