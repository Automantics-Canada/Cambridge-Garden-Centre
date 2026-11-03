import './setupEnv.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import {
  CSV_MIME_TYPE,
  ExtractionError,
  extractInvoice,
  readableDocument,
  setExtractionProviderForTests,
  triageDocument,
  XLSX_MIME_TYPE,
} from '../src/services/extraction/extraction.service.js';
import { toContentPart } from '../src/services/extraction/providers/openai.adapter.js';
import { INVOICE_PROMPT, TRIAGE_PROMPT } from '../src/services/extraction/prompts.js';
import type { ExtractionDocument, ExtractionProvider } from '../src/services/extraction/providers/types.js';

/**
 * Excel and CSV invoices (A12) reach the same invoice reader as PDFs, as text.
 *
 * No model and no network: the provider is a stand-in that records what it
 * was given. Every value in the workbooks is invented.
 */

const sent: Array<{ document: ExtractionDocument; prompt: string; schemaName: string }> = [];
let reply: unknown = null;
const standIn: ExtractionProvider = {
  name: 'stand-in',
  modelId: 'stand-in-model',
  async extract<T>(document: ExtractionDocument, prompt: string, _schema: unknown, schemaName: string): Promise<T> {
    sent.push({ document, prompt, schemaName });
    return reply as T;
  },
};
const restore = setExtractionProviderForTests(standIn);
afterEach(() => {
  sent.length = 0;
});
process.on('exit', restore);

async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const invoice = book.addWorksheet('Invoice');
  invoice.addRow(['Invoice', 'INV-7001', 'Date', new Date(Date.UTC(2026, 9, 28))]);
  invoice.addRow(['Item', 'Qty', 'Unit', 'Price', 'Total']);
  invoice.addRow(['Screened sand', 12, 't', 31.5, { formula: 'B3*D3', result: 378 }]);
  const loads = book.addWorksheet('Loads');
  loads.addRow(['Ticket', 'Net']);
  loads.addRow(['T-9001', 12]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const EMPTY_INVOICE = {
  supplierName: 'Example Stone', invoiceNumber: 'INV-7001', date: '2026-10-28', poNumber: '482913',
  totalAmount: 378, lineItems: [], readability: 'clear', uncertainFields: [],
};

describe('a spreadsheet becomes bounded text', () => {
  it('every sheet of an .xlsx, tab separated, formulas as their saved value', async () => {
    const doc = await readableDocument({ bytes: await workbook(), mimeType: XLSX_MIME_TYPE, filename: 'inv.xlsx' });
    assert.equal(
      doc.text,
      '# Sheet: Invoice\nInvoice\tINV-7001\tDate\t2026-10-28\nItem\tQty\tUnit\tPrice\tTotal\nScreened sand\t12\tt\t31.5\t378\n\n' +
        '# Sheet: Loads\nTicket\tNet\nT-9001\t12'
    );
  });

  it('a CSV, as one sheet', async () => {
    const doc = await readableDocument({
      bytes: Buffer.from('Item,Qty,Price\n"Pea gravel, washed",3,"1,250.00"\n'),
      mimeType: CSV_MIME_TYPE,
      filename: 'inv.csv',
    });
    assert.equal(doc.text, '# Sheet: CSV\nItem\tQty\tPrice\nPea gravel, washed\t3\t1,250.00');
  });

  it('a PDF or an image is left as it is', async () => {
    const pdf = { bytes: Buffer.from('%PDF-1.7'), mimeType: 'application/pdf', filename: 'a.pdf' };
    assert.equal(await readableDocument(pdf), pdf);
  });

  it('a workbook that cannot be read fails for good, without a model call', async () => {
    await assert.rejects(
      () => extractInvoice(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]), XLSX_MIME_TYPE, 'broken.xlsx'),
      (error: unknown) => error instanceof ExtractionError && error.retryable === false
    );
    assert.equal(sent.length, 0);
  });
});

describe('the reader is given text instead of a file', () => {
  it('an .xlsx invoice goes to the invoice reader as text, with the invoice prompt and schema', async () => {
    reply = EMPTY_INVOICE;
    const result = await extractInvoice(await workbook(), XLSX_MIME_TYPE, 'inv.xlsx');
    assert.equal(result.invoiceNumber, 'INV-7001');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.schemaName, 'supplier_invoice');
    assert.equal(sent[0]!.prompt, INVOICE_PROMPT);
    assert.match(sent[0]!.document.text ?? '', /Screened sand\t12\tt\t31\.5\t378/);
  });

  it('the OpenAI request carries the text as input_text, never as a file', () => {
    const part = toContentPart({ bytes: Buffer.from('x'), mimeType: XLSX_MIME_TYPE, filename: 'inv.xlsx', text: 'a\tb' });
    assert.equal(part.type, 'input_text');
    assert.match((part as { text: string }).text, /"inv\.xlsx"[\s\S]*a\tb$/);
    const pdf = toContentPart({ bytes: Buffer.from('%PDF-1.7'), mimeType: 'application/pdf', filename: 'a.pdf' });
    assert.equal(pdf.type, 'input_file');
  });

  it('page sorting uses its own prompt and a small schema, and reads a spreadsheet as text too', async () => {
    reply = { pages: [{ page: 1, kind: 'invoice' }] };
    const answer = await triageDocument(await workbook(), XLSX_MIME_TYPE, 'inv.xlsx');
    assert.deepEqual(answer, { pages: [{ page: 1, kind: 'invoice' }] });
    assert.equal(sent[0]!.prompt, TRIAGE_PROMPT);
    assert.equal(sent[0]!.schemaName, 'attachment_triage');
    assert.ok(sent[0]!.document.text);
  });
});

describe('the invoice prompt', () => {
  // The interim guard while triage is new: a ticket page left inside an
  // invoice PDF must not come back as an invoice line.
  it('tells the reader to ignore ticket pages and statements', () => {
    assert.match(INVOICE_PROMPT, /Ignore delivery or scale ticket pages/);
    assert.match(INVOICE_PROMPT, /Never list a ticket as an invoice line/);
    assert.match(INVOICE_PROMPT, /Ignore account statements/);
  });
});
