/**
 * The bounded CSV / .xlsx reader. Every workbook here is built in the test
 * with invented values; no fixture file is committed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';

import {
  SpreadsheetError,
  cellText,
  detectSpreadsheetKind,
  firstSheetWithRows,
  readSpreadsheet,
  spreadsheetToText,
  zipDeclaredSize,
} from '../src/lib/spreadsheet.js';

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SpreadsheetError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

describe('telling the file kinds apart', () => {
  it('judges by content, with the name only deciding between text and nothing', async () => {
    const xlsx = await workbook((wb) => wb.addWorksheet('S').addRow(['a']));
    assert.equal(detectSpreadsheetKind(xlsx, 'prices.xlsx'), 'xlsx');
    assert.equal(detectSpreadsheetKind(xlsx), 'xlsx');
    // A ZIP named .docx is not a workbook.
    assert.equal(detectSpreadsheetKind(xlsx, 'letter.docx'), null);
    assert.equal(detectSpreadsheetKind(Buffer.from('a,b\n1,2\n'), 'prices.csv'), 'csv');
    assert.equal(detectSpreadsheetKind(Buffer.from('a,b\n1,2\n'), 'prices.pdf'), null);
    assert.equal(detectSpreadsheetKind(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]), 'x.csv'), null);
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    assert.equal(detectSpreadsheetKind(ole, 'old.xls'), 'xls');
  });

  it('refuses a legacy .xls with a way out', async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    await assert.rejects(readSpreadsheet(ole, { filename: 'old.xls' }), /save it as \.xlsx or CSV UTF-8/);
  });

  it('refuses empty, oversized and unsupported files', async () => {
    await rejects(readSpreadsheet(Buffer.alloc(0)), 'EMPTY');
    await rejects(readSpreadsheet(Buffer.from('a,b\n'), { limits: { maxBytes: 2 } }), 'TOO_LARGE');
    await rejects(readSpreadsheet(Buffer.from('a,b\n'), { filename: 'x.pdf' }), 'UNSUPPORTED');
  });
});

describe('CSV', () => {
  it('reads a CSV saved by Excel: BOM, quotes, CRLF, blank lines and row numbers', async () => {
    const csv = '﻿product,rate\r\n"Test Gravel, washed",18.50\r\n\r\nTest Sand,32\r\n';
    const result = await readSpreadsheet(Buffer.from(csv), { filename: 'prices.csv' });
    const sheet = firstSheetWithRows(result)!;
    assert.equal(result.kind, 'csv');
    assert.deepEqual(sheet.rows, [['product', 'rate'], ['Test Gravel, washed', '18.50'], ['Test Sand', '32']]);
    assert.deepEqual(sheet.rowNumbers, [1, 2, 4]);
  });

  it('reads a semicolon CSV, as Excel saves in some locales', async () => {
    const result = await readSpreadsheet(Buffer.from('product;rate\nTest Sand;32\n'));
    assert.deepEqual(result.sheets[0]!.rows[1], ['Test Sand', '32']);
  });

  it('refuses more rows than allowed, or keeps the first ones when asked to', async () => {
    const csv = ['h', ...Array.from({ length: 20 }, (_, i) => `r${i}`)].join('\n');
    await rejects(readSpreadsheet(Buffer.from(csv), { limits: { maxRows: 5 } }), 'TOO_MANY_ROWS');
    const kept = await readSpreadsheet(Buffer.from(csv), { limits: { maxRows: 5 }, overflow: 'truncate' });
    assert.equal(kept.sheets[0]!.rows.length, 5);
    assert.equal(kept.sheets[0]!.truncated, true);
  });

  it('cuts overlong cells and extra columns, and says so', async () => {
    const result = await readSpreadsheet(Buffer.from(`a,b,c\n${'x'.repeat(50)},2,3\n`), {
      limits: { maxCellChars: 10, maxColumns: 2 },
    });
    const sheet = result.sheets[0]!;
    assert.deepEqual(sheet.rows[1], ['xxxxxxxxxx', '2']);
    assert.equal(sheet.truncated, true);
  });

  it('does not count empty trailing columns as cut', async () => {
    // Excel writes commas out to the edge of any range ever formatted.
    const result = await readSpreadsheet(Buffer.from(`a,b,,,,\n1,2,,,,\n`), { limits: { maxColumns: 2 } });
    assert.deepEqual(result.sheets[0]!.rows, [['a', 'b'], ['1', '2']]);
    assert.equal(result.sheets[0]!.truncated, false);
  });

  it('reads a plain Excel CSV (Windows-1252) without mangling accents and dashes', async () => {
    // "Pierre – Sablé" in Windows-1252: 0x96 is an en dash, 0xE9 is é.
    const bytes = Buffer.concat([
      Buffer.from('product,rate\r\nPierre '),
      Buffer.from([0x96]),
      Buffer.from(' Sabl'),
      Buffer.from([0xe9]),
      Buffer.from(',18.50\r\n'),
    ]);
    const result = await readSpreadsheet(bytes, { filename: 'prices.csv' });
    assert.deepEqual(result.sheets[0]!.rows[1], ['Pierre – Sablé', '18.50']);
    const utf8 = await readSpreadsheet(Buffer.from('product,rate\nPierre – Sablé,18.50\n'), { filename: 'prices.csv' });
    assert.deepEqual(utf8.sheets[0]!.rows[1], ['Pierre – Sablé', '18.50']);
  });
});

describe('.xlsx', () => {
  it('reads values, saved formula results, dates and rich text as plain text', async () => {
    const buffer = await workbook((wb) => {
      const ws = wb.addWorksheet('Prices');
      ws.addRow(['product', 'rate', 'effective_from', 'notes']);
      ws.addRow(['Test Gravel 19mm', 18.5, new Date(Date.UTC(2026, 10, 1)), { richText: [{ text: 'Agreed ' }, { text: 'by phone' }] }]);
      ws.addRow(['Test Sand', { formula: 'B2*2', result: 37 }, '2026-11-01', null]);
      ws.addRow([]);
      ws.addRow(['Test Stone', { formula: 'NOW()' }, '2026-11-01']);
    });
    const result = await readSpreadsheet(buffer, { filename: 'prices.xlsx' });
    const sheet = firstSheetWithRows(result)!;
    assert.equal(result.kind, 'xlsx');
    assert.equal(sheet.name, 'Prices');
    assert.deepEqual(sheet.rows, [
      ['product', 'rate', 'effective_from', 'notes'],
      ['Test Gravel 19mm', '18.5', '2026-11-01', 'Agreed by phone'],
      ['Test Sand', '37', '2026-11-01'],
      // A formula with no saved result is blank: nothing is ever evaluated.
      ['Test Stone', '', '2026-11-01'],
    ]);
    assert.deepEqual(sheet.rowNumbers, [1, 2, 3, 5]);
  });

  it('ignores styled empty cells past the column limit, but marks a value there as cut', async () => {
    const buffer = await workbook((wb) => {
      const ws = wb.addWorksheet('Prices');
      ws.addRow(['product', 'rate']);
      ws.addRow(['Test Sand', 32]);
      // A border on an empty cell far to the right, as a formatted range leaves.
      ws.getCell('AZ2').border = { top: { style: 'thin' } };
    });
    const clean = await readSpreadsheet(buffer, { limits: { maxColumns: 5 } });
    assert.deepEqual(clean.sheets[0]!.rows, [['product', 'rate'], ['Test Sand', '32']]);
    assert.equal(clean.sheets[0]!.truncated, false);

    const withValue = await workbook((wb) => {
      const ws = wb.addWorksheet('Prices');
      ws.addRow(['product', 'rate']);
      ws.getCell('AZ2').value = 'stray';
    });
    const cut = await readSpreadsheet(withValue, { limits: { maxColumns: 5 } });
    assert.equal(cut.sheets[0]!.truncated, true);
    assert.equal(cut.sheets[0]!.rows[0]!.length, 2);
  });

  it('reads every sheet, and the first with rows is the one a price list uses', async () => {
    const buffer = await workbook((wb) => {
      wb.addWorksheet('Cover');
      wb.addWorksheet('Prices').addRow(['product']);
      wb.addWorksheet('Old').addRow(['legacy']);
    });
    const result = await readSpreadsheet(buffer);
    assert.equal(result.sheets.length, 3);
    assert.equal(firstSheetWithRows(result)!.name, 'Prices');
  });

  it('refuses a workbook that would expand past the limit, before opening it', async () => {
    const buffer = await workbook((wb) => {
      const ws = wb.addWorksheet('Big');
      for (let i = 0; i < 200; i++) ws.addRow([`row ${i}`, 'x'.repeat(200)]);
    });
    const declared = zipDeclaredSize(buffer);
    assert.ok(declared && declared.bytes > 0 && declared.entries > 0);
    await rejects(readSpreadsheet(buffer, { limits: { maxUncompressedBytes: 1_000 } }), 'TOO_LARGE');
  });

  it('refuses a broken ZIP as unreadable', async () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
    await rejects(readSpreadsheet(broken, { filename: 'x.xlsx' }), 'UNREADABLE');
  });
});

describe('cells and text', () => {
  it('turns each kind of cell into text', () => {
    assert.equal(cellText(null), '');
    assert.equal(cellText(3.25), '3.25');
    assert.equal(cellText(true), 'TRUE');
    assert.equal(cellText({ text: 'link', hyperlink: 'https://example.invalid' }), 'link');
    assert.equal(cellText({ error: '#DIV/0!' }), '');
    assert.equal(cellText({ sharedFormula: 'A1', result: 4 }), '4');
  });

  it('gives a bounded text version for a text reader', async () => {
    const result = await readSpreadsheet(Buffer.from('a,b\n"1,250.00",x\n'));
    assert.deepEqual(spreadsheetToText(result), { text: '# Sheet: CSV\na\tb\n1,250.00\tx', truncated: false });
    assert.equal(spreadsheetToText(result, 5).truncated, true);
  });
});
