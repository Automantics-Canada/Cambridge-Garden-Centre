/**
 * Reads a CSV or .xlsx file into rows of plain text, within fixed bounds.
 *
 * Two things need this: supplier price lists loaded on the Rates page, and
 * Excel invoices that arrive by email. Both are files a stranger can shape,
 * so everything here is bounded before it is trusted: the file size, the
 * uncompressed size of an .xlsx (it is a ZIP, and a small ZIP can expand to
 * gigabytes; the size is measured while inflating, never taken from the
 * file's own headers), the number of sheets, rows and columns, and the
 * length of each cell.
 *
 * Every cell comes back as a string. A formula gives the value Excel last
 * saved for it and is never evaluated; a date cell becomes `YYYY-MM-DD`;
 * rich text and hyperlinks become their text. Macros and styles are ignored.
 *
 * Legacy `.xls` files are refused with a reason rather than guessed at: the
 * reader used here (exceljs) cannot read them.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';

export type SpreadsheetKind = 'csv' | 'xlsx';

export interface SpreadsheetLimits {
  /** Largest file accepted, in bytes. */
  maxBytes: number;
  /** For .xlsx: the most the ZIP may expand to, in bytes. */
  maxUncompressedBytes: number;
  maxSheets: number;
  /** Rows per sheet, counting the header row. */
  maxRows: number;
  maxColumns: number;
  /** Characters per cell; longer cells are cut and the sheet is marked. */
  maxCellChars: number;
}

export const DEFAULT_SPREADSHEET_LIMITS: SpreadsheetLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxUncompressedBytes: 40 * 1024 * 1024,
  maxSheets: 10,
  maxRows: 5_000,
  maxColumns: 50,
  maxCellChars: 1_000,
};

export interface SpreadsheetSheet {
  name: string;
  /** Rows as read, blank rows dropped. Each row is trimmed of trailing blanks. */
  rows: string[][];
  /** The 1-based row number in the original file for each entry in `rows`. */
  rowNumbers: number[];
  /** True when rows, columns or cell text were cut to fit the limits. */
  truncated: boolean;
}

export interface SpreadsheetResult {
  kind: SpreadsheetKind;
  sheets: SpreadsheetSheet[];
}

export type SpreadsheetErrorCode =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'LEGACY_XLS'
  | 'UNSUPPORTED'
  | 'UNREADABLE';

export class SpreadsheetError extends Error {
  readonly status: number;
  constructor(readonly code: SpreadsheetErrorCode, message: string) {
    super(message);
    this.name = 'SpreadsheetError';
    this.status = code === 'TOO_LARGE' || code === 'TOO_MANY_ROWS' ? 413 : 415;
    if (code === 'EMPTY' || code === 'UNREADABLE') this.status = 400;
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
// Compound File Binary, the container of legacy .xls (and .doc).
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function extensionOf(filename: string | undefined): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename ?? '');
  return match ? match[1]!.toLowerCase() : '';
}

/**
 * What kind of spreadsheet these bytes are, judged by content first.
 *
 * The extension only decides between "text" and nothing: a CSV has no magic
 * bytes, so text is a CSV only when it is named `.csv` (or has no name). A ZIP
 * is an .xlsx only when it is named `.xlsx` or has no name, so a `.docx` is
 * not read as a workbook.
 */
export function detectSpreadsheetKind(
  buffer: Buffer,
  filename?: string
): SpreadsheetKind | 'xls' | null {
  const ext = extensionOf(filename);
  if (buffer.length >= OLE_MAGIC.length && buffer.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) {
    return ext === '' || ext === 'xls' ? 'xls' : null;
  }
  if (buffer.length >= ZIP_MAGIC.length && buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    return ext === '' || ext === 'xlsx' ? 'xlsx' : null;
  }
  if (ext !== '' && ext !== 'csv' && ext !== 'txt') return null;
  // Binary content is not a CSV, whatever it is called. UTF-16 text (Excel's
  // "Unicode Text") also lands here, because it is full of zero bytes.
  if (buffer.subarray(0, 4096).includes(0)) return null;
  return 'csv';
}

/**
 * Total uncompressed size declared by a ZIP's central directory.
 *
 * Read before the workbook is opened, so an archive that would expand far
 * beyond what a price list or invoice needs is refused without being inflated.
 * Returns null when the directory cannot be read, which callers treat as
 * unreadable.
 */
export function zipDeclaredSize(buffer: Buffer): { bytes: number; entries: number } | null {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entries = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 markers: far larger than anything accepted here.
  if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) return null;
  if (dirOffset + dirSize > buffer.length) return null;

  let bytes = 0;
  let at = dirOffset;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) return null;
    const uncompressed = buffer.readUInt32LE(at + 24);
    if (uncompressed === 0xffffffff) return null;
    bytes += uncompressed;
    at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return { bytes, entries };
}

/** Most entries an .xlsx may hold; a real workbook has a few dozen. */
const MAX_ZIP_ENTRIES = 2_000;

/**
 * Every entry of a ZIP, inflated here with a hard cap on the bytes that
 * actually come out, or the reason it is refused.
 *
 * The sizes a ZIP states are the file's own claim: an entry that says 100
 * bytes can hold gigabytes of zeros in a few hundred kilobytes. exceljs
 * (through JSZip) inflates an entry whole and only then compares it with
 * the claim, so a small upload or email attachment could exhaust the
 * process's memory. Here each entry is inflated by zlib with
 * `maxOutputLength` set to what is left of the limit, which stops inflating
 * the moment it is passed.
 */
export function inflateZipBounded(
  buffer: Buffer,
  maxBytes: number
): { ok: true; entries: Array<{ name: Buffer; utf8: boolean; data: Buffer }> } | { ok: false; code: 'TOO_LARGE' | 'UNREADABLE' } {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, code: 'UNREADABLE' };
  const count = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) return { ok: false, code: 'UNREADABLE' };
  if (count > MAX_ZIP_ENTRIES) return { ok: false, code: 'TOO_LARGE' };
  if (dirOffset + dirSize > buffer.length) return { ok: false, code: 'UNREADABLE' };

  const entries: Array<{ name: Buffer; utf8: boolean; data: Buffer }> = [];
  let total = 0;
  let at = dirOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) return { ok: false, code: 'UNREADABLE' };
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    // Encrypted entries, and compression other than none or deflate, are
    // nothing Excel writes for a workbook.
    if (flags & 0x1) return { ok: false, code: 'UNREADABLE' };
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) return { ok: false, code: 'UNREADABLE' };
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length) return { ok: false, code: 'UNREADABLE' };
    const packed = buffer.subarray(start, start + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = packed;
    } else if (method === 8) {
      try {
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, maxBytes - total) });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return { ok: false, code: code === 'ERR_BUFFER_TOO_LARGE' ? 'TOO_LARGE' : 'UNREADABLE' };
      }
    } else {
      return { ok: false, code: 'UNREADABLE' };
    }
    total += data.length;
    if (total > maxBytes) return { ok: false, code: 'TOO_LARGE' };
    entries.push({ name, utf8: Boolean(flags & 0x800), data });
  }
  return { ok: true, entries };
}

/**
 * A ZIP of the given entries, stored without compression. What exceljs is
 * handed after inflateZipBounded: it can only copy these bytes, whose size is
 * already known, and never inflates anything itself.
 */
export function storedZip(entries: ReadonlyArray<{ name: Buffer; utf8: boolean; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const crc = crc32(entry.data);
    const flags = entry.utf8 ? 0x800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    parts.push(local, entry.name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, entry.name);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** One exceljs cell value as plain text. Never evaluates anything. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : isoDate(value);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // A formula: the value Excel saved last time it calculated. A formula
    // that was never calculated has no result and reads as blank.
    if ('formula' in v || 'sharedFormula' in v) return cellText(v.result);
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: unknown }>).map((part) => String(part.text ?? '')).join('');
    }
    if ('text' in v) return cellText(v.text);
    if ('error' in v) return '';
  }
  return '';
}

/** Comma, semicolon or tab, whichever the header line uses most. */
function guessDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

interface Bounded {
  rows: string[][];
  rowNumbers: number[];
  truncated: boolean;
}

/** Applies column and cell limits to one row; reports whether it cut anything. */
function boundRow(cells: string[], limits: SpreadsheetLimits): { row: string[]; cut: boolean } {
  // Only columns past the limit that hold something count as cut. Excel
  // writes empty cells out to the edge of whatever range was ever formatted,
  // so a CSV with a long run of trailing commas, or a workbook with a styled
  // row, would otherwise be refused for losing nothing.
  let cut = cells.slice(limits.maxColumns).some((cell) => cell.trim() !== '');
  const row = cells.slice(0, limits.maxColumns).map((cell) => {
    const text = cell.replace(/\r\n?/g, '\n').trim();
    if (text.length > limits.maxCellChars) {
      cut = true;
      return text.slice(0, limits.maxCellChars);
    }
    return text;
  });
  while (row.length > 0 && row[row.length - 1] === '') row.pop();
  return { row, cut };
}

function pushRow(target: Bounded, cells: string[], rowNumber: number, limits: SpreadsheetLimits, overflow: 'error' | 'truncate') {
  const { row, cut } = boundRow(cells, limits);
  if (row.length === 0) {
    // A row whose only content lies past the column limit was still cut.
    if (cut) target.truncated = true;
    return true;
  }
  if (target.rows.length >= limits.maxRows) {
    if (overflow === 'error') {
      throw new SpreadsheetError(
        'TOO_MANY_ROWS',
        `The file has more than ${limits.maxRows.toLocaleString('en-CA')} rows. Split it into smaller files.`
      );
    }
    target.truncated = true;
    return false;
  }
  if (cut) target.truncated = true;
  target.rows.push(row);
  target.rowNumbers.push(rowNumber);
  return true;
}

/**
 * The CSV's text. Excel's plain "CSV" (not "CSV UTF-8") is Windows-1252, where
 * an en dash or an accented letter is a byte that is not valid UTF-8. Read as
 * UTF-8, those became replacement characters, and a product name carrying one
 * could never equal the name on an order. Valid UTF-8 is read as UTF-8;
 * anything else as Windows-1252.
 */
function csvText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function readCsv(buffer: Buffer, limits: SpreadsheetLimits, overflow: 'error' | 'truncate'): SpreadsheetSheet {
  const text = csvText(buffer);
  // Blank lines count as records here, hence the headroom. Parsing stops at
  // this many, so a file of a million lines is never read in full.
  const ceiling = limits.maxRows * 2 + 100;
  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parse(text, {
      bom: true,
      delimiter: guessDelimiter(text.replace(/^\uFEFF/, '')),
      info: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      to: ceiling,
    }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  } catch (error) {
    throw new SpreadsheetError('UNREADABLE', `The CSV could not be read: ${(error as Error).message}`);
  }

  const sheet: Bounded = { rows: [], rowNumbers: [], truncated: false };
  for (const { record, info } of records) {
    // `info.lines` is the line a record ends on; a quoted cell can span lines.
    const extraLines = record.reduce((n, cell) => n + (String(cell).match(/\n/g)?.length ?? 0), 0);
    if (!pushRow(sheet, record.map(String), info.lines - extraLines, limits, overflow)) break;
  }
  if (records.length >= ceiling) {
    if (overflow === 'error') {
      throw new SpreadsheetError(
        'TOO_MANY_ROWS',
        `The file has more than ${limits.maxRows.toLocaleString('en-CA')} rows. Split it into smaller files.`
      );
    }
    sheet.truncated = true;
  }
  return { name: 'CSV', ...sheet };
}

async function readXlsx(buffer: Buffer, limits: SpreadsheetLimits, overflow: 'error' | 'truncate'): Promise<SpreadsheetSheet[]> {
  const unreadable = () => new SpreadsheetError('UNREADABLE', 'The .xlsx file could not be read. Save it again from Excel and retry.');
  const tooLarge = () => new SpreadsheetError('TOO_LARGE', 'The workbook is too large to read. Save just the sheet you need and retry.');

  // The sizes the file states, first: an honest large workbook is refused
  // without inflating anything.
  const declared = zipDeclaredSize(buffer);
  if (!declared) throw unreadable();
  if (declared.bytes > limits.maxUncompressedBytes || declared.entries > MAX_ZIP_ENTRIES) throw tooLarge();

  // Then the sizes it really has: a file can state anything.
  const inflated = inflateZipBounded(buffer, limits.maxUncompressedBytes);
  if (!inflated.ok) throw inflated.code === 'TOO_LARGE' ? tooLarge() : unreadable();

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(storedZip(inflated.entries) as unknown as ArrayBuffer);
  } catch (error) {
    throw new SpreadsheetError('UNREADABLE', `The .xlsx file could not be read: ${(error as Error).message}`);
  }

  const sheets: SpreadsheetSheet[] = [];
  for (const worksheet of workbook.worksheets.slice(0, limits.maxSheets)) {
    const sheet: Bounded = { rows: [], rowNumbers: [], truncated: false };
    let stopped = false;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (stopped) return;
      // Only the cells that hold a value are visited (a styled empty cell is
      // skipped), so a stray cell at column XFD costs one read, not 16,384.
      // Anything past the column limit is kept as one marker so boundRow can
      // say the row was cut.
      const cells: string[] = Array.from({ length: Math.min(row.cellCount, limits.maxColumns) }, () => '');
      let beyond = false;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (col <= limits.maxColumns) cells[col - 1] = cellText(cell.value);
        else if (!beyond && cellText(cell.value).trim() !== '') beyond = true;
      });
      if (beyond) cells.push(...Array.from({ length: limits.maxColumns - cells.length }, () => ''), 'x');
      if (!pushRow(sheet, cells, rowNumber, limits, overflow)) stopped = true;
    });
    sheets.push({ name: worksheet.name, ...sheet });
  }
  if (workbook.worksheets.length > limits.maxSheets && sheets[0]) sheets[0].truncated = true;
  return sheets;
}

/**
 * Reads a CSV or .xlsx into bounded rows of text.
 *
 * `overflow: 'error'` (the default) refuses a file with more rows than the
 * limit, which is right for an all-or-nothing import. `'truncate'` keeps the
 * first rows and marks the sheet, which is right for reading an invoice.
 */
export async function readSpreadsheet(
  buffer: Buffer,
  options: { filename?: string | undefined; limits?: Partial<SpreadsheetLimits>; overflow?: 'error' | 'truncate' } = {}
): Promise<SpreadsheetResult> {
  const limits: SpreadsheetLimits = { ...DEFAULT_SPREADSHEET_LIMITS, ...options.limits };
  const overflow = options.overflow ?? 'error';

  if (!buffer || buffer.length === 0) throw new SpreadsheetError('EMPTY', 'The file is empty.');
  if (buffer.length > limits.maxBytes) {
    throw new SpreadsheetError(
      'TOO_LARGE',
      `The file is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`
    );
  }

  const kind = detectSpreadsheetKind(buffer, options.filename);
  if (kind === 'xls') {
    throw new SpreadsheetError(
      'LEGACY_XLS',
      'This is an old Excel (.xls) file. Open it in Excel and save it as .xlsx or CSV UTF-8, then try again.'
    );
  }
  if (!kind) {
    throw new SpreadsheetError('UNSUPPORTED', 'Choose a .csv or .xlsx file.');
  }

  const sheets = kind === 'csv' ? [readCsv(buffer, limits, overflow)] : await readXlsx(buffer, limits, overflow);
  return { kind, sheets };
}

/** The first sheet that has any rows, or null. */
export function firstSheetWithRows(result: SpreadsheetResult): SpreadsheetSheet | null {
  return result.sheets.find((sheet) => sheet.rows.length > 0) ?? null;
}

/**
 * Every sheet as bounded plain text, one line per row, cells separated by tabs.
 *
 * For handing a spreadsheet to a text reader (the invoice extractor). Tabs
 * rather than commas so a cell holding "1,250.00" stays one value.
 */
export function spreadsheetToText(result: SpreadsheetResult, maxChars = 60_000): { text: string; truncated: boolean } {
  let truncated = result.sheets.some((sheet) => sheet.truncated);
  const parts: string[] = [];
  let length = 0;
  for (const sheet of result.sheets) {
    if (sheet.rows.length === 0) continue;
    const block = [`# Sheet: ${sheet.name}`, ...sheet.rows.map((row) => row.map((c) => c.replace(/[\t\n]+/g, ' ')).join('\t'))].join('\n');
    if (length + block.length > maxChars) {
      parts.push(block.slice(0, Math.max(0, maxChars - length)));
      truncated = true;
      break;
    }
    parts.push(block);
    length += block.length + 2;
  }
  return { text: parts.join('\n\n'), truncated };
}
