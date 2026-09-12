import './setupEnv.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from 'csv-parse/sync';

/**
 * The CSV contract the Spruce order importer depends on.
 *
 * `importOrders` feeds a clerk-uploaded file to `csv-parse` with four options —
 * `bom`, `columns: true`, `skip_empty_lines`, `trim` — and then reads the rows by
 * header name. None of that was covered by any test, which mattered when
 * csv-parse had to move across a major version to clear a prototype-replacement
 * advisory reachable through the very `columns: true` path the importer uses.
 *
 * These tests pin the behaviour the importer relies on, so the next upgrade
 * either passes or says exactly what changed. They deliberately exercise the
 * library rather than the service: the risk being managed here is the library's
 * contract, not the database work that follows it.
 *
 * Fixtures are synthetic and shaped like a Spruce export. No client data.
 */

const OPTIONS = { bom: true, columns: true, skip_empty_lines: true, trim: true } as const;

describe('Spruce CSV parsing contract', () => {
  it('reads rows by header name', () => {
    const csv = 'Document,Customer,Product,Quantity\n' + '604412,A Customer,A Gravel 19mm,24.6\n';

    const rows = parse(csv, OPTIONS) as Array<Record<string, string>>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.Document, '604412');
    assert.equal(rows[0]!.Quantity, '24.6');
  });

  it('strips a UTF-8 BOM from the first header', () => {
    // Excel writes one. Without `bom` the first column's name carries an
    // invisible prefix and every lookup of it returns undefined.
    const csv = '﻿Document,Customer\n604412,A Customer\n';

    const rows = parse(csv, OPTIONS) as Array<Record<string, string>>;

    assert.deepEqual(Object.keys(rows[0]!), ['Document', 'Customer']);
  });

  it('trims padded fields and skips blank lines', () => {
    const csv =
      'Document,Customer\r\n' + '  604412 ,  A Customer  \r\n' + '\r\n' + '604413,B Customer\r\n';

    const rows = parse(csv, OPTIONS) as Array<Record<string, string>>;

    assert.equal(rows.length, 2, 'a blank line is not a row');
    assert.equal(rows[0]!.Document, '604412');
    assert.equal(rows[0]!.Customer, 'A Customer');
  });

  it('does not let a header called __proto__ poison the row prototype', () => {
    // The advisory this upgrade cleared: a crafted header reaching object
    // assignment through the `columns: true` path. A Spruce export is uploaded
    // by a signed-in clerk, but the file itself comes from outside.
    const csv = 'Document,__proto__\n604412,polluted\n';

    const rows = parse(csv, OPTIONS) as Array<Record<string, string>>;

    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
    assert.equal(rows[0]!.Document, '604412');
  });

  it('keeps every row distinct when documents repeat', () => {
    // Spruce repeats the document number across a multi-line order. The importer
    // relies on getting one row per line, not a merged record.
    const csv =
      'Document,Product,Quantity\n' +
      '604412,A Gravel 19mm,24.6\n' +
      '604412,B Sand,12.0\n' +
      '604413,A Gravel 19mm,8.4\n';

    const rows = parse(csv, OPTIONS) as Array<Record<string, string>>;

    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.Quantity),
      ['24.6', '12.0', '8.4']
    );
  });
});
