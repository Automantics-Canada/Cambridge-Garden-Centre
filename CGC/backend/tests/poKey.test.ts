/**
 * The key a PO number is compared on.
 *
 * The defect pinned here: Spruce prints its POs as `2608-355356`, and the
 * engine only accepted six digits, so not one ticket or invoice ever linked to
 * an order on a Spruce PO. The opposite failure matters as much — two POs that
 * differ only in their prefix are two purchase orders, and paying one against
 * the other is the mistake this system exists to stop.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalPoNumber,
  onSamePo,
  poKey,
  poNumbersMatch,
} from '../src/modules/matching/poKey.js';

describe('poKey', () => {
  it('reads the Spruce form, however it was written down', () => {
    for (const raw of [
      '2608-355356',
      ' 2608-355356 ',
      '2608 355356',
      '2608 - 355356',
      '2608–355356',
      'PO# 2608-355356',
      'PO 2608-355356',
      'po#2608-355356',
      'P.O. 2608 355356',
      'P.O. No. 2608-355356',
      'Purchase Order: 2608-355356',
    ]) {
      assert.deepEqual(poKey(raw), { prefix: '2608', suffix: '355356' }, JSON.stringify(raw));
    }
  });

  it('reads six digits exactly as extraction always has', () => {
    for (const raw of ['355356', 'PO# 355356', '355-356', ' 355356 ']) {
      assert.deepEqual(poKey(raw), { prefix: null, suffix: '355356' }, JSON.stringify(raw));
    }
  });

  it('refuses what is neither form', () => {
    for (const raw of [
      null,
      undefined,
      '',
      '   ',
      '12345',
      '1234567',
      'CGC-99',
      // Ten digits run together is also a phone number.
      '2608355356',
      '519-555-0128',
      '260-8355356',
      '2608-35535',
      '12608-355356',
    ]) {
      assert.equal(poKey(raw as string | null | undefined), null, JSON.stringify(raw));
    }
  });

  it('spells the key the way Spruce prints it', () => {
    assert.equal(canonicalPoNumber('PO# 2608 355356'), '2608-355356');
    assert.equal(canonicalPoNumber('355-356'), '355356');
    assert.equal(canonicalPoNumber('CGC-99'), null);
  });
});

describe('poNumbersMatch', () => {
  it('the same Spruce PO matches itself in every spelling', () => {
    assert.ok(poNumbersMatch('2608-355356', '2608-355356'));
    assert.ok(poNumbersMatch('2608 355356', '2608-355356'));
    assert.ok(poNumbersMatch('PO# 2608-355356', '2608-355356'));
  });

  it('a bare six digit PO matches the Spruce PO that ends with it', () => {
    assert.ok(poNumbersMatch('355356', '2608-355356'));
    assert.ok(poNumbersMatch('2608-355356', 'PO# 355356'));
  });

  it('two prefixes with the same six digits are two different POs', () => {
    assert.equal(poNumbersMatch('2607-355356', '2608-355356'), false);
    assert.equal(poNumbersMatch('PO# 2607 355356', '2608-355356'), false);
  });

  it('different six digits never match, whatever the prefix', () => {
    assert.equal(poNumbersMatch('2608-355357', '2608-355356'), false);
    assert.equal(poNumbersMatch('355357', '2608-355356'), false);
  });

  it('six digit POs still match each other as before', () => {
    assert.ok(poNumbersMatch('482913', '482913'));
    assert.ok(poNumbersMatch('482-913', '482913'));
    assert.equal(poNumbersMatch('482913', '482914'), false);
  });

  it('a value that is not a PO matches nothing, not even itself', () => {
    assert.equal(poNumbersMatch('CGC-99', 'CGC-99'), false);
    assert.equal(poNumbersMatch(null, '2608-355356'), false);
    assert.equal(poNumbersMatch(null, null), false);
  });
});

describe('onSamePo', () => {
  it('compares on the key', () => {
    assert.ok(onSamePo('355356', '2608-355356'));
    assert.equal(onSamePo('2607-355356', '2608-355356'), false);
  });

  it('still pairs two copies of the same unreadable value, as it did before the key', () => {
    assert.ok(onSamePo('CGC-99', 'CGC-99'));
    assert.equal(onSamePo('CGC-99', 'CGC-98'), false);
    assert.equal(onSamePo(null, null), false);
    assert.equal(onSamePo('', ''), false);
  });
});
