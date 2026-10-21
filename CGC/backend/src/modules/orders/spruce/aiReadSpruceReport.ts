import { createHash } from 'node:crypto';
import { z } from 'zod';

import { env } from '../../../config/env.js';
import { SprucePdfError, type PdfTextPage } from '../../../lib/pdf/pdfWords.js';
import { clusterRows } from '../../../lib/pdf/textGeometry.js';
import { extractStructured } from '../../../services/extraction/extraction.service.js';
import {
  DOCUMENT_NUMBER_PATTERN,
  parseSpruceNumber,
  type ParsedSpruceReport,
  type ParsedSpruceRow,
  type SpruceReportType,
  type UnreadableSpruceRow,
} from './spruceReportTypes.js';

/**
 * Reads a Spruce report with an AI model, for the layouts the layout readers
 * do not know.
 *
 * The layout readers are exact but brittle: on 21/10/2026 Spruce printed the
 * Item Tracking report on one wide page and added headings to the Deliveries
 * report, and the morning's upload failed. A model reads a changed layout as
 * easily as the old one. What it can do that the readers cannot is invent: a
 * quantity, a PO, a whole line. So nothing it says is taken on trust —
 *
 *  - it is given the report's own text layer as well as the PDF, so it copies
 *    characters rather than reading pixels;
 *  - every value it returns must be in that text: a document number, item
 *    code, PO, name or address that is not printed in the report, or a
 *    figure the report does not print, puts its line in `unreadable` instead
 *    of in the import;
 *  - every document number printed in the report must come back with at least
 *    one line, or the miss is reported.
 *
 * What survives is the same `ParsedSpruceRow` the readers produce, so the
 * import, its cross-report checks and its flags treat it exactly the same.
 */

/** Text-layer characters per unit of x, enough to keep adjacent columns apart. */
const CHARS_PER_UNIT = 4;

/**
 * The text layer laid out as the page prints it, one line per visual row,
 * each run at its column. Models read a table laid out this way far more
 * reliably than a list of fragments.
 */
export function layoutText(pages: PdfTextPage[]): string {
  return pages
    .map(page => {
      const lines = clusterRows(page.runs).map(row => {
        let line = '';
        for (const run of [...row.runs].sort((a, b) => a.x - b.x)) {
          const text = run.text.trim();
          if (!text) continue;
          const column = Math.max(0, Math.round(run.x * CHARS_PER_UNIT));
          line = line.length < column ? line.padEnd(column) : line + (line ? '  ' : '');
          line += text;
        }
        return line.trimEnd();
      });
      return `=== Page ${page.pageIndex + 1} ===\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

type FieldKind = 'text' | 'number';

/** Every field the model may fill, what it is, and the row field it becomes. */
const FIELDS = {
  documentNumber: ['text', 'The order\'s Spruce document number, NNNN-NNNNNN ("Document" / "Order#" column). Never a PO Document number.'],
  customerName: ['text', 'The customer. On the Deliveries report, where the order row names an account such as "Cash Sales", the person printed under it.'],
  accountName: ['text', 'Deliveries report only: the account name printed on the order row itself ("Cash Sales").'],
  accountCode: ['text', 'The account code, e.g. CASH or EARTHWOR0.'],
  product: ['text', 'The item description, with any wrapped continuation lines joined in with single spaces. Never a column heading.'],
  itemNumber: ['text', 'The item code, e.g. AGG3/4C, SOILGRDNA, COMMENT, MISCDELD.'],
  quantity: ['number', 'The quantity ordered, as a number (40.0000 is 40).'],
  unit: ['text', 'The unit of measure as printed (CY, MT, EA, SQFT...); null where it is a dash or not printed.'],
  orderDate: ['text', 'The order / entry date, exactly as printed.'],
  deliveryDate: ['text', 'The delivery date, exactly as printed. On the Deliveries report, the date at the start of the order row.'],
  shippingAddress: ['text', 'Item Tracking only: the Shipping Address, exactly as printed.'],
  deliveryInstructions: ['text', 'Item Tracking only: Delivery Instructions.'],
  deliveryTruck: ['text', 'Item Tracking only: Delivery Truck.'],
  orderNotes: ['text', 'Item Tracking only: Order Notes.'],
  vendorName: ['text', 'Item Tracking only: the Vendor code, e.g. UNILOCKL01.'],
  vendorLocation: ['text', 'Item Tracking only: Vendor Location.'],
  poNumber: ['text', 'Item Tracking only: the PO Document number raised on the vendor.'],
  poValue: ['number', 'Item Tracking only: PO Value.'],
  phone: ['text', 'Deliveries report only: the phone number, with any EXT. extension.'],
  route: ['text', 'Deliveries report only: the route code, often blank.'],
  spruceStatus: ['text', 'The order status word as printed (Open, Sched...).'],
  cashier: ['text', 'Order Summary only: Cashier.'],
  deliveryFlag: ['text', 'Order Summary only: the Delivery column (e.g. SCH).'],
  totalWithTax: ['number', 'The order total including tax ("Total w/tax" / "Total").'],
  remainingDeposit: ['number', 'Order Summary only: Rem Dep.'],
  remaining: ['number', 'Order Summary only: Remaining.'],
  grossMarginPct: ['number', 'Order Summary only: GM%, as a number (45.80% is 45.8).'],
  unitPrice: ['number', 'Order Summary only: the line\'s UnitPrice.'],
  unitCost: ['number', 'Order Summary only: the line\'s unit cost.'],
} as const satisfies Record<string, readonly [FieldKind, string]>;

type FieldName = keyof typeof FIELDS;

/** Which fields each report prints, so the model is asked only for those. */
const REPORT_FIELDS: Record<SpruceReportType, FieldName[]> = {
  ORDER_SUMMARY: [
    'documentNumber', 'customerName', 'accountCode', 'cashier', 'spruceStatus', 'deliveryFlag', 'deliveryDate',
    'orderDate', 'remainingDeposit', 'totalWithTax', 'grossMarginPct', 'remaining', 'itemNumber', 'product',
    'quantity', 'unit', 'unitPrice', 'unitCost',
  ],
  DELIVERY: [
    'deliveryDate', 'documentNumber', 'spruceStatus', 'route', 'accountCode', 'accountName', 'customerName', 'phone',
    'totalWithTax', 'itemNumber', 'product', 'quantity', 'unit',
  ],
  ITEM_TRACKING: [
    'documentNumber', 'deliveryDate', 'orderDate', 'customerName', 'shippingAddress', 'deliveryInstructions',
    'deliveryTruck', 'orderNotes', 'itemNumber', 'product', 'quantity', 'vendorName', 'vendorLocation', 'poNumber',
    'poValue',
  ],
};

const REPORT_NAMES: Record<SpruceReportType, string> = {
  ORDER_SUMMARY: 'Customer Order Summary ("Order Report")',
  DELIVERY: 'Deliveries report (delivery run sheet)',
  ITEM_TRACKING: 'Sales Order Item Tracking ("Custom Report")',
};

function fieldsFor(type: SpruceReportType | null): FieldName[] {
  return type ? REPORT_FIELDS[type] : (Object.keys(FIELDS) as FieldName[]);
}

function answerSchema(type: SpruceReportType | null) {
  const line: Record<string, z.ZodType> = { page: z.number().int() };
  for (const name of fieldsFor(type)) {
    line[name] = FIELDS[name][0] === 'number' ? z.number().nullable() : z.string().nullable();
  }
  return z.object({
    reportType: z.enum(['ORDER_SUMMARY', 'DELIVERY', 'ITEM_TRACKING', 'NOT_SPRUCE']),
    lines: z.array(z.object(line)),
  });
}

/** One line of the model's answer: its page, and the fields its report has. */
export type AnswerLine = { page: number } & Partial<Record<FieldName, string | number | null>>;

export function spruceReportPrompt(type: SpruceReportType | null, layout: string): string {
  const fields = fieldsFor(type).map(name => `- ${name}: ${FIELDS[name][1]}`).join('\n');
  const which = type
    ? `This is the ${REPORT_NAMES[type]}. Answer reportType "${type}".`
    : 'Say which report it is in reportType: ORDER_SUMMARY, DELIVERY or ITEM_TRACKING, or NOT_SPRUCE if it is none ' +
      'of the three Spruce order reports (then return no lines).';

  return `You are reading a report exported from Spruce, the order system of Cambridge Garden Centre, so that the
day's orders can be imported for dispatch. ${which}

Return one entry in "lines" for every item line in the report, in the order printed. An item line is one item
(code, description, quantity) of one order. Every line carries the facts of the order it belongs to, repeated.

Rules:
- Copy text exactly as printed. Never correct, expand, guess or reformat a value. A value the report does not
  print for that line is null.
- A description that wraps onto the lines below belongs to the item above it. Orders continue across page
  breaks: lines at the top of a page may belong to the last order on the page before.
- Column headings ("Item Description Qty U/M", "Date Document Type ..."), page letterheads, page numbers,
  parameter lines and report titles are not data. Never put them in a field.
- Comment lines (item code COMMENT and similar), delivery charges and skid deposits are item lines too: include
  them.
- "page" is the 1-based page the item line is printed on.

Fields:
${fields}

The report's text layer follows, laid out as printed, each page marked. It is exact: copy from it.

${layout}`;
}

/** Characters stripped from both ends before comparing a word with the report. */
const EDGE_PUNCTUATION = /^[\s,.;:()*"'$]+|[\s,.;:()*"'$%]+$/g;

const words = (value: string) =>
  value.toLowerCase().split(/[\s,]+/).map(word => word.replace(EDGE_PUNCTUATION, '')).filter(Boolean);

/** Everything the report prints, as words and as figures, for checking answers against. */
interface PrintedText {
  words: Set<string>;
  /**
   * The words run together, so that a word the report wraps over two lines
   * ("cambridgegardencentr" / "e.ca") is still found when read joined up.
   */
  joined: string;
  figures: number[];
  documentNumbers: Set<string>;
}

function printedText(pages: PdfTextPage[]): PrintedText {
  const printed: PrintedText = { words: new Set(), joined: '', figures: [], documentNumbers: new Set() };
  for (const page of pages) {
    for (const run of page.runs) {
      for (const word of words(run.text)) {
        printed.words.add(word);
        if (DOCUMENT_NUMBER_PATTERN.test(word)) printed.documentNumbers.add(word);
      }
      // Figures split on spaces only: "3,298.96" is one figure, not 3 and 298.96.
      for (const word of run.text.split(/\s+/)) {
        const figure = parseSpruceNumber(word.replace(EDGE_PUNCTUATION, ''));
        if (figure !== null) printed.figures.push(figure);
      }
    }
  }
  // A wrapped description continues in its own column, so the joining is done
  // column by column, top to bottom.
  const columns = new Map<string, typeof pages[number]['runs']>();
  for (const page of pages) {
    for (const run of page.runs) {
      const key = `${page.pageIndex}:${Math.round(run.x * 10)}`;
      columns.set(key, [...(columns.get(key) ?? []), run]);
    }
  }
  printed.joined = [...columns.values()]
    .map(runs => runs.sort((a, b) => a.y - b.y).flatMap(run => words(run.text)).join(''))
    .join('|');
  return printed;
}

/** What one order's part of the report prints: from its document number to the next. */
interface OrderBlock {
  words: Set<string>;
  figures: number[];
}

/**
 * Each order's block of the report, by document number.
 *
 * A line read off the wrong order is the mistake no other check sees — on
 * 21/10/2026 the model moved "3 Permacon Skid Deposit" from 2610-721465 to
 * 2610-721461, every value of it printed in the report. Its item code and
 * quantity must be printed inside its own order's block.
 *
 * The order summary and the delivery report print an order's row and then its
 * lines, running on across page breaks. The item-tracking report prints the
 * document on every line, so there a block never runs past its page; on the
 * banded layout the lines are on other pages from their document numbers, the
 * blocks hold no item codes, and the check stands aside.
 */
function orderBlocks(type: SpruceReportType, pages: PdfTextPage[], poNumbers: Set<string>): Map<string, OrderBlock> {
  const blocks = new Map<string, OrderBlock>();
  let current: OrderBlock | null = null;

  for (const page of pages) {
    if (type === 'ITEM_TRACKING') current = null;
    for (const row of clusterRows(page.runs)) {
      const runs = [...row.runs].sort((a, b) => a.x - b.x);
      const documentNumber = runs
        .flatMap(run => run.text.split(/\s+/))
        .map(text => text.replace(EDGE_PUNCTUATION, ''))
        .find(text => DOCUMENT_NUMBER_PATTERN.test(text) && !poNumbers.has(text));
      if (documentNumber) {
        current = blocks.get(documentNumber) ?? { words: new Set(), figures: [] };
        blocks.set(documentNumber, current);
      }
      if (!current) continue;
      for (const run of runs) {
        for (const word of words(run.text)) current.words.add(word);
        for (const word of run.text.split(/\s+/)) {
          const figure = parseSpruceNumber(word.replace(EDGE_PUNCTUATION, ''));
          if (figure !== null) current.figures.push(figure);
        }
      }
    }
  }
  return blocks;
}

/** Why `value` cannot be taken from the report, or null when it can. */
function notPrinted(kind: FieldKind, value: string | number, printed: PrintedText): string | null {
  if (kind === 'number') {
    const figure = Number(value);
    if (!Number.isFinite(figure)) return `${value} is not a number`;
    return printed.figures.some(seen => Math.abs(seen - figure) < 0.0001) ? null : `${value} is not printed in the report`;
  }
  const missing = words(String(value)).filter(word => !printed.words.has(word) && !printed.joined.includes(word));
  return missing.length ? `"${String(value)}" is not printed in the report` : null;
}

/**
 * The shape a field's value must have. Being printed somewhere in the report
 * is not enough: on 21/10/2026 the model once returned the document number as
 * the delivery date — printed, and in the wrong field.
 */
const SPRUCE_DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const SHAPES: Partial<Record<FieldName, RegExp>> = {
  documentNumber: DOCUMENT_NUMBER_PATTERN,
  poNumber: DOCUMENT_NUMBER_PATTERN,
  orderDate: SPRUCE_DATE,
  deliveryDate: SPRUCE_DATE,
  phone: /\d{3}\D*\d{4}/,
};

/** The row-field name for an answer field, where the two differ. */
const ROW_FIELD: Partial<Record<FieldName, keyof ParsedSpruceRow>> = {
  orderDate: 'orderDateRaw',
  deliveryDate: 'deliveryDateRaw',
};

/**
 * Keeps the lines whose every value is printed in the report, and reports the
 * rest. Pure, so the guard can be tested without a model.
 */
export function vetAnswer(
  type: SpruceReportType,
  lines: AnswerLine[],
  pages: PdfTextPage[]
): { rows: ParsedSpruceRow[]; unreadable: UnreadableSpruceRow[] } {
  const printed = printedText(pages);
  const rows: ParsedSpruceRow[] = [];
  const unreadable: UnreadableSpruceRow[] = [];
  const poNumbers = new Set(lines.map(line => String(line.poNumber ?? '').trim()).filter(Boolean));
  const blocks = orderBlocks(type, pages, poNumbers);
  const itemCode = (line: AnswerLine) => words(String(line.itemNumber ?? ''))[0];
  // Banded item tracking: no block carries an item code, so placement cannot be checked.
  const placeable = [...blocks.values()].some(block => lines.some(line => {
    const code = itemCode(line);
    return code !== undefined && block.words.has(code);
  }));

  lines.forEach((line, index) => {
    const at = { page: Number.isInteger(line.page) && line.page > 0 ? line.page : 1, row: index + 1 };
    const documentNumber = typeof line.documentNumber === 'string' ? line.documentNumber.trim() : '';
    const problems: string[] = [];

    if (!DOCUMENT_NUMBER_PATTERN.test(documentNumber)) problems.push(`document number "${documentNumber}" is not one`);
    if (typeof line.quantity !== 'number') problems.push('no quantity');
    if (typeof line.product !== 'string' || !line.product.trim()) problems.push('no description');

    const row: Record<string, unknown> = { source: at };
    for (const name of REPORT_FIELDS[type]) {
      const value = line[name];
      if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue;
      // Spruce prints a dash where a line has no unit.
      if (name === 'unit' && /^-+$/.test(String(value).trim())) continue;
      const shape = SHAPES[name];
      const problem = shape && !shape.test(String(value).trim())
        ? `"${String(value)}" is not a ${name}`
        : notPrinted(FIELDS[name][0], value, printed);
      if (problem) {
        problems.push(`${name} ${problem}`);
        continue;
      }
      row[ROW_FIELD[name] ?? name] = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
    }
    row.customerName ??= '';

    const block = blocks.get(documentNumber);
    const code = itemCode(line);
    if (placeable && block && code !== undefined && typeof line.quantity === 'number') {
      const quantity = line.quantity;
      if (!block.words.has(code) || !block.figures.some(figure => Math.abs(figure - quantity) < 0.0001)) {
        problems.push(`${line.itemNumber} x ${quantity} is not printed under this order`);
      }
    }

    if (problems.length) {
      unreadable.push({ ...at, reason: `AI-read line ${documentNumber || '(no document)'}: ${problems.join('; ')}` });
    } else {
      rows.push(row as unknown as ParsedSpruceRow);
    }
  });

  // An order the model skipped would otherwise vanish without a trace.
  const read = new Set(lines.map(line => String(line.documentNumber ?? '').trim()));
  for (const documentNumber of printed.documentNumbers) {
    if (read.has(documentNumber) || poNumbers.has(documentNumber)) continue;
    unreadable.push({ page: 1, row: 0, reason: `Document ${documentNumber} is in the report but the AI read no lines for it` });
  }

  return { rows, unreadable };
}

/**
 * Answers already given, by file and model, for an hour.
 *
 * The import screen reads each file when it is dropped in and again when
 * Process is pressed; without this the model would be asked twice.
 */
const answers = new Map<string, { at: number; report: Promise<ParsedSpruceReport> }>();
const ANSWER_TTL_MS = 60 * 60 * 1000;
const MAX_ANSWERS = 12;

/** Large enough for a busy day's report, far below the model's ceiling. */
const MAX_OUTPUT_TOKENS = 64_000;

export async function aiReadSpruceReport(
  buffer: Buffer,
  pages: PdfTextPage[],
  type: SpruceReportType | null
): Promise<ParsedSpruceReport> {
  const key = `${env.spruceAiModelId}:${type ?? '?'}:${createHash('sha256').update(buffer).digest('hex')}`;
  const cached = answers.get(key);
  if (cached && Date.now() - cached.at < ANSWER_TTL_MS) return cached.report;

  const report = (async () => {
    const answer = await extractStructured(
      { bytes: buffer, mimeType: 'application/pdf', filename: 'spruce-report.pdf' },
      spruceReportPrompt(type, layoutText(pages)),
      answerSchema(type),
      'spruce_report',
      { modelId: env.spruceAiModelId, maxOutputTokens: MAX_OUTPUT_TOKENS }
    );

    if (answer.reportType === 'NOT_SPRUCE' || (type && answer.reportType !== type)) {
      throw new SprucePdfError(
        'UNKNOWN_REPORT',
        'This does not look like one of the three Spruce order reports. Export it again from Spruce.'
      );
    }

    const read = vetAnswer(answer.reportType, answer.lines as AnswerLine[], pages);
    return { type: answer.reportType, ...read, readBy: 'AI' as const };
  })();

  answers.set(key, { at: Date.now(), report });
  report.catch(() => answers.delete(key));
  while (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value!);
  return report;
}
