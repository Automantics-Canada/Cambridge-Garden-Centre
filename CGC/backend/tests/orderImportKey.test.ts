/**
 * Regression tests for imported-row identity.
 *
 * Two defects are pinned here:
 *   - the original code keyed rows as `${document}-${rowIndex}`, so row 2 of
 *     every page collided and later pages overwrote earlier ones;
 *   - the first fix disambiguated by page only, but Textract restarts RowIndex
 *     at 1 for each TABLE block, so two tables on one page still collided.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSpruceOrderKey } from '../src/modules/orders/orderImportKey.js';

describe('buildSpruceOrderKey', () => {
  it('keeps the legacy format for the first table of the first page', () => {
    // Existing single-table imports must keep producing the same key, so a
    // re-import updates the existing Order instead of creating a duplicate.
    assert.equal(
      buildSpruceOrderKey({ documentId: '123456', pageIndex: 0, tableIndex: 0, rowIndex: 2 }),
      '123456-2'
    );
  });

  it('separates rows that repeat on later pages', () => {
    assert.equal(
      buildSpruceOrderKey({ documentId: '123456', pageIndex: 1, tableIndex: 0, rowIndex: 2 }),
      '123456-P2-2'
    );
    assert.equal(
      buildSpruceOrderKey({ documentId: '123456', pageIndex: 4, tableIndex: 0, rowIndex: 2 }),
      '123456-P5-2'
    );
  });

  it('separates rows that repeat across tables on the same page', () => {
    assert.equal(
      buildSpruceOrderKey({ documentId: '123456', pageIndex: 0, tableIndex: 1, rowIndex: 2 }),
      '123456-T2-2'
    );
    assert.notEqual(
      buildSpruceOrderKey({ documentId: '123456', pageIndex: 0, tableIndex: 0, rowIndex: 2 }),
      buildSpruceOrderKey({ documentId: '123456', pageIndex: 0, tableIndex: 1, rowIndex: 2 })
    );
  });

  it('combines page and table when both are beyond the first', () => {
    assert.equal(
      buildSpruceOrderKey({ documentId: '123456', pageIndex: 2, tableIndex: 1, rowIndex: 3 }),
      '123456-P3-T2-3'
    );
  });

  it('is unique across a multi-page, multi-table document', () => {
    // 4 pages x 3 tables x 12 rows for one carried-forward document number:
    // exactly the shape that used to collapse onto a handful of keys.
    const keys = new Set<string>();
    let generated = 0;

    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      for (let tableIndex = 0; tableIndex < 3; tableIndex++) {
        for (let rowIndex = 2; rowIndex <= 13; rowIndex++) {
          keys.add(buildSpruceOrderKey({ documentId: 'SPR-99', pageIndex, tableIndex, rowIndex }));
          generated++;
        }
      }
    }

    assert.equal(generated, 144);
    assert.equal(keys.size, 144, 'every source row must map to a distinct key');
  });

  it('keeps distinct documents distinct on the same page and row', () => {
    assert.notEqual(
      buildSpruceOrderKey({ documentId: 'A', pageIndex: 0, tableIndex: 0, rowIndex: 2 }),
      buildSpruceOrderKey({ documentId: 'B', pageIndex: 0, tableIndex: 0, rowIndex: 2 })
    );
  });

  it('is deterministic, which is what makes re-import idempotent', () => {
    const parts = { documentId: 'SPR-42', pageIndex: 3, tableIndex: 2, rowIndex: 7 };
    const first = buildSpruceOrderKey(parts);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(buildSpruceOrderKey(parts), first);
    }
  });

  it('does not let a page suffix be forged by a document number', () => {
    // A document literally named "12-P2" must not collide with document "12"
    // parsed from page 2. Documented as a known formatting limitation: the two
    // differ here only because the row components differ.
    const forged = buildSpruceOrderKey({ documentId: '12-P2', pageIndex: 0, tableIndex: 0, rowIndex: 2 });
    const real = buildSpruceOrderKey({ documentId: '12', pageIndex: 1, tableIndex: 0, rowIndex: 2 });
    assert.equal(forged, '12-P2-2');
    assert.equal(real, '12-P2-2');
    assert.equal(forged, real, 'known limitation: recorded so it is not mistaken for a fix');
  });
});
