// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import * as extraction from '../src/services/extraction/extraction.service.js';
import {
  parseArgs,
  formatDryRun,
  runSampleDryRun,
  type DryRunOptions,
  type DryRunReport,
} from '../src/scripts/invoiceSampleDryRun.js';
import { totalsCheck, unitReport, compareWithManifest } from '../src/scripts/sampleDryRun/checks.js';
import {
  assertLoopbackDatabase,
  inReadOnlyTransaction,
  loadRelatedRecordsFromDb,
  type ReadOnlyDb,
} from '../src/scripts/sampleDryRun/loopbackRecords.js';
import {
  ExtractionFixtureSchema,
  SampleManifestSchema,
} from '../src/scripts/sampleDryRun/sampleFiles.js';
import {
  parseRelatedRecords,
  resolveSupplierLikeProduction,
  storedLineLikeProduction,
} from '../src/modules/matching/dryRunDecision.js';
import type { NormalizedInvoice } from '../src/services/extraction/normalize.js';
import type { ExtractionDocument, ExtractionProvider } from '../src/services/extraction/providers/types.js';

/**
 * The sample dry run (A13): the client's real invoices are read and matched
 * with nothing written anywhere.
 *
 * No model, no network, no database. The readings are pre-extracted JSON, the
 * PDF and the workbook are built here, and every supplier, number and price
 * is invented. The examples shipped in docs/invoice-samples/ are used as the
 * related records, so they cannot drift from what the script accepts.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.join(here, '..', 'docs', 'invoice-samples');
const readExample = (name: string): unknown => JSON.parse(readFileSync(path.join(examples, name), 'utf8'));

const PDF_NAME = 'example-aggregates-INV-55001.pdf';
const XLSX_NAME = 'sample-haulage-weekly.xlsx';

async function threePagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of ['Invoice INV-55001', 'Invoice INV-55001 continued', 'Ticket EX-70013']) {
    document.addPage([400, 300]).drawText(text, { x: 20, y: 150, font, size: 14 });
  }
  return Buffer.from(await document.save());
}

async function haulageWorkbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const invoice = book.addWorksheet('Invoice');
  invoice.addRow(['Sample Haulage Inc.', 'Invoice', 'SH-2026-118']);
  invoice.addRow(['Ticket', 'Date', 'Description', 'Loads', 'Rate', 'Amount']);
  invoice.addRow(['SH-501', new Date(Date.UTC(2026, 9, 22)), 'Triaxle haul', 1, 225, 225]);
  invoice.addRow(['SH-502', new Date(Date.UTC(2026, 9, 22)), 'Triaxle haul', 3, 240, { formula: 'D4*E4', result: 720 }]);
  const notes = book.addWorksheet('Notes');
  notes.addRow(['Weekly statement of loads']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const haulageReading = {
  triage: { pages: [{ page: 1, kind: 'invoice' }] },
  invoice: {
    supplierName: 'Sample Haulage Inc',
    invoiceNumber: 'SH-2026-118',
    date: '2026-10-23',
    poNumber: '2610-900103',
    // Deliberately not 945 x 1.13: the totals check must say so.
    totalAmount: 1017,
    lineItems: [
      { description: 'Test Haul Triaxle', quantity: 1, unit: 'load', unitPrice: 225, totalPrice: 225, poNumber: null, ticketNumber: 'SH-501' },
      { description: 'Test Haul Triaxle', quantity: 3, unit: 'trk', unitPrice: 240, totalPrice: 720, poNumber: null, ticketNumber: 'SH-502' },
    ],
    readability: 'clear',
    uncertainFields: [],
  },
};

let dir: string;
let report: DryRunReport;
let fetchCalls = 0;
const realFetch = globalThis.fetch;

function options(over: Partial<DryRunOptions> = {}): DryRunOptions {
  return { dir, mode: 'fixture', saveExtractions: false, related: { kind: 'auto' }, only: [], writeReport: true, ...over };
}

before(async () => {
  // Any network call during a dry run is a failure of the test, not a skip.
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('The sample dry run must not use the network');
  }) as typeof fetch;

  dir = mkdtempSync(path.join(tmpdir(), 'cgc-samples-'));
  writeFileSync(path.join(dir, PDF_NAME), await threePagePdf());
  writeFileSync(path.join(dir, `${PDF_NAME}.extraction.json`), readFileSync(path.join(examples, 'extraction.example.json')));
  writeFileSync(path.join(dir, XLSX_NAME), await haulageWorkbook());
  writeFileSync(path.join(dir, `${XLSX_NAME}.extraction.json`), JSON.stringify(haulageReading));
  // The old Excel format: the inbox sends it to a person, and so does this.
  writeFileSync(path.join(dir, 'old-format.xls'), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]));
  // A photo with no pre-extracted reading: reported, never sent to a model.
  writeFileSync(path.join(dir, 'unread-photo.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20_000)]));
  writeFileSync(path.join(dir, 'manifest.json'), readFileSync(path.join(examples, 'manifest.example.json')));
  writeFileSync(path.join(dir, 'related.json'), readFileSync(path.join(examples, 'related.example.json')));

  report = await runSampleDryRun(options(), { extraction });
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const sample = (file: string) => {
  const found = report.samples.find((entry) => entry.file === file);
  assert.ok(found, `no report for ${file}`);
  return found;
};

describe('sample dry run, pre-extracted readings', () => {
  it('sorts a multi-page PDF the way the inbox does and reads the invoice and ticket pages', () => {
    const pdf = sample(PDF_NAME);
    assert.equal(pdf.reader, 'pre-extracted');
    assert.equal(pdf.error, null);
    assert.equal(pdf.pages?.count, 3);
    assert.equal(pdf.pages?.split, true);
    assert.equal(pdf.pages?.description, 'pages 1-2 invoice; page 3 delivery ticket');
    assert.deepEqual(pdf.ticketPages.map((t) => [t.page, t.ticketNumber]), [[3, 'EX-70013']]);
    assert.equal(pdf.invoice?.invoiceNumber, 'INV-55001');
    assert.equal(pdf.invoice?.invoiceDate, '2026-10-22');
    assert.equal(pdf.invoice?.lines.length, 3);
    assert.deepEqual(pdf.fill?.header.filter((f) => !f.filled).map((f) => f.field), ['poNumber']);
    assert.deepEqual(pdf.expectations.filter((e) => !e.ok), []);
  });

  it('checks the lines against the printed total, finding the 13% HST', () => {
    const totals = sample(PDF_NAME).totals!;
    assert.equal(totals.verdict, 'adds-up-with-hst');
    assert.equal(totals.subtotal, 1320.21);
    assert.equal(totals.impliedHst, 171.63);
  });

  it('lists units the engine does not recognise, and nothing is added for them', () => {
    assert.deepEqual(sample(PDF_NAME).units, { unknown: [{ unit: 'ld', lines: [3] }], missing: [] });
    assert.deepEqual(report.summary.unknownUnits, [
      { unit: 'ld', count: 1, files: [PDF_NAME] },
      { unit: 'trk', count: 1, files: [XLSX_NAME] },
    ]);
  });

  it('previews the verdicts production would store, counting an emailed ticket copy once', () => {
    const lines = sample(PDF_NAME).matching!.lines;
    assert.equal(lines[0]!.status, 'MATCHED');
    assert.equal(lines[0]!.flag, 'OK');
    assert.equal(lines[0]!.order?.orderNumber, '990101');
    assert.equal(lines[0]!.approvedTotal, 945);
    // Offered, as loadCandidateOrders would: 990101 on the PO and 990102 from
    // the supplier inside the date window. The quotation on the same PO is not.
    assert.equal(lines[0]!.considered.orders, 2);
    assert.deepEqual(lines[0]!.tickets.map((t) => t.ticketNumber).sort(), ['EX-70011', 'EX-70012']);

    // The driver's ticket and the supplier's copy on page 3 are one load.
    assert.equal(lines[1]!.flag, 'RATE_UNKNOWN');
    assert.deepEqual(lines[1]!.tickets.map((t) => t.ticketNumber), ['EX-70013']);
    assert.ok(lines[1]!.checks.some((c) => c.name === 'copiesAgree' && c.passed));

    assert.equal(lines[2]!.flag, 'MULTIPLE_FLAGS');
    assert.equal(sample(PDF_NAME).matching!.invoiceTotalCheck.result, 'unpriced');
  });

  it('reads an Excel invoice as text through the production reader, and finds what is wrong with it', () => {
    const sheet = sample(XLSX_NAME);
    assert.equal(sheet.intake.kind, 'spreadsheet');
    assert.equal(sheet.spreadsheet?.sheets, 2);
    assert.ok((sheet.spreadsheet?.characters ?? 0) > 50);
    assert.equal(sheet.supplier?.resolution, 'contains');
    assert.equal(sheet.supplier?.supplierType, 'TRUCKING_COMPANY');
    assert.equal(sheet.totals?.verdict, 'does-not-add-up');
    assert.equal(sheet.totals?.difference, 72);
    // A field this build's reader does not keep is still shown from the reply.
    assert.deepEqual(sheet.invoice?.lines.map((l) => l.ticketNumber), ['SH-501', 'SH-502']);
    const [first] = sheet.matching!.lines;
    assert.match(first!.checks.find((c) => c.name === 'ticketCoverage')!.detail, /already been used/);
    assert.ok(first!.considered.competingLines >= 1);
    assert.ok(sheet.warnings.some((w) => /dispatcher's rate/.test(w)));
  });

  it('sends the old .xls format to a person and never asks a model about a file it has no reading for', () => {
    assert.equal(sample('old-format.xls').intake.action, 'review');
    assert.match(sample('old-format.xls').intake.reason ?? '', /\.xls/);
    assert.match(sample('unread-photo.png').error ?? '', /extraction\.json/);
    assert.equal(fetchCalls, 0);
  });

  it('writes the report beside the samples, saying nothing was written anywhere else', () => {
    const written = JSON.parse(readFileSync(path.join(dir, 'dry-run-report.json'), 'utf8')) as DryRunReport;
    assert.equal(written.writes, 'none');
    assert.equal(written.relatedRecords, 'related.json');
    assert.equal(written.summary.files, 4);
    assert.equal(written.summary.invoicesRead, 2);
    assert.deepEqual(written.summary.missingFromManifest, []);
    const text = formatDryRun(report);
    assert.match(text, /Already paid: never enter this invoice in production/);
    assert.match(text, /Units to confirm before any alias is added: "ld" x1, "trk" x1/);
  });

  it('puts the real reader back after the run', () => {
    assert.notEqual(extraction.activeProvider().name, 'pre-extracted');
  });
});

describe('sample dry run, reading with a model', () => {
  it('sends the spreadsheet as text through the production reader, and saves the replies for offline runs', async () => {
    const live = mkdtempSync(path.join(tmpdir(), 'cgc-samples-live-'));
    try {
      writeFileSync(path.join(live, XLSX_NAME), await haulageWorkbook());
      const asked: Array<{ schemaName: string; text: string | undefined }> = [];
      // Stands in for the model: the real one is never called by a test.
      const model: ExtractionProvider = {
        name: 'stand-in-model',
        modelId: 'stand-in',
        async extract<T>(document: ExtractionDocument, _prompt: string, _schema: unknown, schemaName: string): Promise<T> {
          asked.push({ schemaName, text: document.text });
          return (schemaName === 'attachment_triage' ? haulageReading.triage : haulageReading.invoice) as T;
        },
      };

      const first = await runSampleDryRun(
        options({ dir: live, mode: 'ai', saveExtractions: true, related: { kind: 'none' } }),
        { extraction, liveProvider: model }
      );
      assert.deepEqual(asked.map((a) => a.schemaName), ['attachment_triage', 'supplier_invoice']);
      assert.match(asked[1]!.text ?? '', /# Sheet: Invoice[\s\S]*SH-502\t2026-10-22\tTriaxle haul\t3\t240\t720/);
      assert.equal(first.reader, 'model');
      assert.ok(existsSync(path.join(live, `${XLSX_NAME}.extraction.json`)));

      const offline = await runSampleDryRun(options({ dir: live, related: { kind: 'none' } }), { extraction });
      assert.deepEqual(offline.samples[0]!.invoice, first.samples[0]!.invoice);
      assert.equal(offline.samples[0]!.matching, null);
      assert.equal(offline.samples[0]!.supplier?.resolution, 'not checked');
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });
});

describe('totals and units', () => {
  const invoice = (lines: Array<Partial<NormalizedInvoice['lineItems'][number]>>, total: number | null): NormalizedInvoice => ({
    supplierName: 'Example Aggregates Ltd.',
    invoiceNumber: 'INV-1',
    invoiceDate: null,
    poNumber: null,
    totalAmount: total,
    lineItems: lines.map((line) => ({ description: 'Stone', quantity: null, unit: 't', unitPrice: null, totalPrice: null, poNumber: null, ...line })),
    confidence: 0.95,
    readability: 'clear',
    uncertainFields: [],
  });

  it('counts a tax line as tax, and finds a line whose arithmetic is wrong', () => {
    const check = totalsCheck(invoice([{ quantity: 10, unitPrice: 20, totalPrice: 210 }, { description: 'HST 13%', totalPrice: 27.3 }], 237.3));
    assert.equal(check.verdict, 'adds-up');
    assert.equal(check.taxLines, 27.3);
    assert.deepEqual(check.arithmetic, [{ line: 1, quantityTimesPrice: 200, amount: 210 }]);
  });

  it('cannot check a total when a line has no amount, or when there is no total', () => {
    assert.equal(totalsCheck(invoice([{ quantity: 2 }], 50)).verdict, 'incomplete');
    assert.equal(totalsCheck(invoice([{ totalPrice: 50 }], null)).verdict, 'no-total');
  });

  it('separates an unrecognised unit from a missing one', () => {
    assert.deepEqual(unitReport(invoice([{ unit: 'skd' }, { unit: null }, { unit: 'tonnes' }, { unit: 'skd' }], 0)), {
      unknown: [{ unit: 'skd', lines: [1, 4] }],
      missing: [2],
    });
  });

  it('flags a PO on the invoice that the manifest did not list', () => {
    const results = compareWithManifest(invoice([{ poNumber: '2610-900101' }, { poNumber: '2610-900555' }], 10), { poNumbers: ['900101'] }, null);
    assert.deepEqual(results.map((r) => [r.field, r.ok]), [['poNumber', true], ['unexpectedPo', false]]);
  });
});

describe('what production would store and file under', () => {
  it('stores an unread quantity and price as 0, an unread unit as "unknown", and falls back to the invoice PO', () => {
    assert.deepEqual(
      storedLineLikeProduction({ description: '', quantity: null, unit: null, unitPrice: null, totalPrice: null, poNumber: null }, 0, '2610-900101'),
      { lineNumber: 1, description: 'Unknown Item', poNumber: '2610-900101', quantity: 0, unit: 'unknown', unitRate: 0, lineTotal: 0 }
    );
  });

  it('resolves a printed supplier name like findOrCreateSupplier, and says when it would create one', () => {
    const { suppliers } = parseRelatedRecords(readExample('related.example.json'));
    assert.equal(resolveSupplierLikeProduction('example aggregates ltd.', suppliers).how, 'exact');
    assert.equal(resolveSupplierLikeProduction('Sample Haulage', suppliers).how, 'contains');
    assert.equal(resolveSupplierLikeProduction('Example Aggregate Ltd', suppliers).how, 'fuzzy');
    const created = resolveSupplierLikeProduction('Nobody Paving Co', suppliers);
    assert.equal(created.how, 'would-create');
    assert.equal(resolveSupplierLikeProduction(null, suppliers).how, 'none');
  });

  it('refuses a related.json that names a supplier it does not list', () => {
    assert.throws(
      () => parseRelatedRecords({ suppliers: [], orders: [{ product: 'Stone', supplier: 'Ghost Ltd.' }] }),
      /orders\[0\]: supplier "Ghost Ltd\." is not in the suppliers list/
    );
  });

  it('ships examples the script accepts', () => {
    assert.doesNotThrow(() => SampleManifestSchema.parse(readExample('manifest.example.json')));
    assert.doesNotThrow(() => ExtractionFixtureSchema.parse(readExample('extraction.example.json')));
    assert.doesNotThrow(() => parseRelatedRecords(readExample('related.example.json')));
  });
});

describe('loopback guard', () => {
  it('refuses a missing DATABASE_URL rather than letting Prisma find one in .env', () => {
    assert.throws(() => assertLoopbackDatabase({}), /DATABASE_URL is not set/);
  });

  it('refuses a remote host, a remote host hidden in the query, and a remote DIRECT_URL', () => {
    assert.throws(() => assertLoopbackDatabase({ DATABASE_URL: 'postgresql://u:p@db.example-prod.invalid:5432/app' }), /non-loopback.*db\.example-prod\.invalid/);
    assert.throws(() => assertLoopbackDatabase({ DATABASE_URL: 'postgresql://u:p@localhost/app?host=db.example-prod.invalid' }), /host=db\.example-prod\.invalid/);
    assert.throws(
      () => assertLoopbackDatabase({ DATABASE_URL: 'postgresql://u:p@127.0.0.1/app', DIRECT_URL: 'postgresql://u:p@10.0.0.5/app' }),
      /DIRECT_URL host: 10\.0\.0\.5/
    );
    assert.throws(() => assertLoopbackDatabase({ DATABASE_URL: 'not a url' }), /not a valid database URL/);
  });

  it('accepts a database on this machine', () => {
    assert.equal(assertLoopbackDatabase({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/x' }), 'postgresql://u:p@127.0.0.1:5432/x');
    assert.doesNotThrow(() => assertLoopbackDatabase({ DATABASE_URL: 'postgresql://u:p@[::1]:5432/x' }));
  });

  it('refuses --save-extractions without the model', () => {
    assert.throws(() => parseArgs(['--no-ai', '--save-extractions']), /only makes sense/);
    const parsed = parseArgs(['--dir=/tmp/x', '--db', '--only', 'a.pdf']);
    assert.notEqual(parsed, 'help');
    assert.deepEqual(parsed !== 'help' && [parsed.dir, parsed.related.kind, parsed.only], ['/tmp/x', 'db', ['a.pdf']]);
  });
});

describe('nothing is written', () => {
  /** A stand-in database that records every call and only knows how to read. */
  function recordingDb() {
    const calls: string[] = [];
    const model = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, method: string) => async () => {
            calls.push(`${name}.${method}`);
            return [];
          },
        }
      );
    const db = new Proxy({} as Record<string, unknown>, {
      get: (_target, name: string) => {
        if (name.startsWith('$')) {
          return async (statement: string) => {
            calls.push(`${name}(${statement})`);
            return 0;
          };
        }
        return model(name);
      },
    });
    return { db, calls };
  }

  it('reads the related records with findMany alone', async () => {
    const { db, calls } = recordingDb();
    const records = await loadRelatedRecordsFromDb(db as unknown as ReadOnlyDb, [], {
      poNumbers: ['2610-900101'],
      supplierDates: [{ supplierId: 'sup-1', date: new Date('2026-10-22T00:00:00Z') }],
    });
    assert.equal(records.orders.length, 0);
    assert.ok(calls.length >= 5);
    assert.deepEqual(calls.filter((call) => !call.endsWith('.findMany')), []);
  });

  it('opens a READ ONLY transaction before the first read', async () => {
    const { db, calls } = recordingDb();
    const client = { $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db) };
    await inReadOnlyTransaction(client as never, async (tx) => tx.supplier.findMany());
    assert.deepEqual(calls, ['$executeRawUnsafe(SET TRANSACTION READ ONLY)', 'supplier.findMany']);
  });

  it('never imports a module that writes to the database, storage or mail', () => {
    const forbidden = [
      'db/prisma.ts',
      'services/fileStorage.ts',
      'services/supabaseStorage.ts',
      'services/mail.service.ts',
      'services/gmail.service.ts',
      'services/notification.service.ts',
      'services/ocrJobProcessor.ts',
      'modules/matching/matching.service.ts',
      'modules/invoices/invoice.service.ts',
      'modules/tickets/ticket.service.ts',
      'modules/supplier/supplier.service.ts',
    ];
    const src = path.join(here, '..', 'src');
    const seen = new Set<string>();
    const queue = [path.join(src, 'scripts', 'invoiceSampleDryRun.ts')];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(file), match[1]!).replace(/\.js$/, '.ts');
        if (existsSync(target)) queue.push(target);
      }
    }
    const reached = [...seen].map((file) => path.relative(src, file).split(path.sep).join('/'));
    assert.ok(reached.includes('services/extraction/extraction.service.ts'), 'the walk should reach the reader');
    assert.deepEqual(reached.filter((file) => forbidden.includes(file)), []);
  });

  it('refuses samples git would commit', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'cgc-samples-repo-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(path.join(repo, 'invoice.pdf'), '%PDF-1.4');
      await assert.rejects(
        runSampleDryRun(options({ dir: repo, writeReport: false }), { extraction }),
        /git would commit invoice\.pdf/
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
