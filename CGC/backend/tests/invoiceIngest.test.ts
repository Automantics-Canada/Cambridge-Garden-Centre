/**
 * `Invoice.gmailMessageId` is @unique, and locally-originated uploads have to
 * synthesise one. The original `staff-${Date.now()}` / `manual-${Date.now()}`
 * form collided whenever two uploads landed in the same millisecond, which
 * surfaced as an opaque 500 rather than anything an operator could act on.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  syntheticMessageId,
  isUniqueConstraintError,
} from '../src/modules/invoices/invoice.controller.js';

describe('syntheticMessageId', () => {
  it('keeps the origin prefix so ingest source stays identifiable', () => {
    assert.match(syntheticMessageId('staff'), /^staff-/);
    assert.match(syntheticMessageId('manual'), /^manual-/);
  });

  it('does not collide within the same millisecond', () => {
    // The exact failure the Date.now() version had: a tight loop completes well
    // inside one millisecond, so every id here would previously have been equal.
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      ids.add(syntheticMessageId('staff'));
    }
    assert.equal(ids.size, 5000, 'every generated id must be distinct');
  });

  it('keeps different origins in separate namespaces', () => {
    const staff = syntheticMessageId('staff');
    assert.equal(staff.startsWith('manual-'), false);
  });
});

describe('isUniqueConstraintError', () => {
  it('recognises a Prisma P2002 violation', () => {
    assert.equal(isUniqueConstraintError({ code: 'P2002' }), true);
  });

  it('ignores unrelated failures so they still reach the error handler', () => {
    assert.equal(isUniqueConstraintError({ code: 'P2025' }), false);
    assert.equal(isUniqueConstraintError(new Error('network down')), false);
    assert.equal(isUniqueConstraintError(null), false);
    assert.equal(isUniqueConstraintError(undefined), false);
  });
});
