/**
 * Shows what the app would do with the client's sample invoices, without
 * putting them anywhere.
 *
 * The client is sending us one or two recent invoices per main supplier (A13),
 * directly, not through ap@ or the app. They are real and probably already
 * paid, so they must never be loaded into production. This reads each one the
 * way an emailed invoice is read (attachment checks, page sorting, Excel/CSV
 * to text, the invoice and ticket readers), then asks the matching engine
 * what it would decide for every line against records we hand it: a
 * related.json written from the Spruce numbers the client gives us, or a
 * disposable loopback database (--db). It prints a summary and writes
 * dry-run-report.json beside the samples.
 *
 * Nothing is written to any database, nothing is uploaded to storage and no
 * email is sent. The modules that do those things are never imported (a unit
 * test walks the imports to keep it that way), the --db reads run inside a
 * READ ONLY transaction on a loopback host, and the report is refused when
 * git would commit it.
 *
 *   npm run samples:dry-run -- --no-ai            pre-extracted readings, offline
 *   npm run samples:dry-run                       read with the model (needs OPENAI_API_KEY)
 *   npm run samples:dry-run -- --save-extractions keep the model's readings for offline re-runs
 *   DATABASE_URL=postgresql://…@127.0.0.1:…/disposable npm run samples:dry-run -- --no-ai --db
 *
 * See docs/invoice-samples.md for how the samples are collected and what the
 * report means.
 */
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDownloaded, storedFileName, type AttachmentRecord } from '../services/emailAttachments.js';
import { describePages, planPages, unsortedPlan, type PagePlan } from '../services/emailTriage.js';
import { ExtractionError, type ExtractionProvider } from '../services/extraction/providers/types.js';
import type { NormalizedInvoice, NormalizedTicket } from '../services/extraction/normalize.js';
import { extractPdfPages, MAX_SPLIT_PAGES, pdfPageCount } from '../lib/pdfPages.js';
import {
  decideInvoiceLineDryRun,
  emptyRelatedRecords,
  parseRelatedRecords,
  previewInvoiceTotalCheck,
  resolveSupplierLikeProduction,
  storedLineLikeProduction,
  withEmailedTickets,
  type InvoiceTotalCheck,
  type RelatedRecords,
  type RelatedSupplier,
  type SupplierResolution,
} from '../modules/matching/dryRunDecision.js';
import {
  compareWithManifest,
  fillReport,
  lineField,
  totalsCheck,
  unitReport,
  type ExpectationResult,
  type FillReport,
  type TotalsCheck,
  type UnitReport,
} from './sampleDryRun/checks.js';
import { fixtureReader, rawInvoiceLines, recordingReader, type ReaderSession } from './sampleDryRun/readers.js';
import {
  ExtractionFixtureSchema,
  extractionFixturePath,
  gitIgnoreState,
  listSampleFiles,
  MANIFEST_FILE,
  RELATED_FILE,
  REPORT_FILE,
  SAMPLE_EXTENSIONS,
  SampleManifestSchema,
  type ExtractionFixture,
  type ManifestEntry,
} from './sampleDryRun/sampleFiles.js';
import type { RecordsRequest } from './sampleDryRun/loopbackRecords.js';

// ---------------------------------------------------------------------------
// Options and dependencies
// ---------------------------------------------------------------------------

export interface DryRunOptions {
  /** The folder holding the samples (and manifest.json, related.json). */
  dir: string;
  /** 'fixture' answers from `<file>.extraction.json`; 'ai' asks the model. */
  mode: 'fixture' | 'ai';
  /** In 'ai' mode, write the model's replies to `<file>.extraction.json`. */
  saveExtractions: boolean;
  /** Where the orders, tickets and rates for the matching preview come from. */
  related: { kind: 'auto' } | { kind: 'none' } | { kind: 'file'; path: string } | { kind: 'db' };
  /** Only these sample files, by name. Empty means all. */
  only: string[];
  writeReport: boolean;
}

/** The production extraction functions the dry run calls. Loaded after the environment is set. */
export interface ExtractionApi {
  triageDocument: (bytes: Buffer, mimeType: string, filename?: string) => Promise<{ pages: Array<{ page: number; kind: PagePlan['pages'][number]['kind'] }> }>;
  extractInvoice: (bytes: Buffer, mimeType: string, filename?: string) => Promise<NormalizedInvoice>;
  extractTicket: (bytes: Buffer, mimeType: string, filename?: string) => Promise<NormalizedTicket>;
  readableDocument: (document: { bytes: Buffer; mimeType: string; filename: string }) => Promise<{ text?: string }>;
  mimeTypeForFilename: (filename: string) => string;
  setExtractionProviderForTests: (provider: ExtractionProvider) => () => void;
}

/** Read-only access to a loopback database, for --db. */
export interface DbRecordsSource {
  loadSuppliers(): Promise<RelatedSupplier[]>;
  loadRecords(suppliers: RelatedSupplier[], request: RecordsRequest): Promise<RelatedRecords>;
}

export interface DryRunDeps {
  extraction: ExtractionApi;
  /** The real model, in 'ai' mode. */
  liveProvider?: ExtractionProvider;
  db?: DbRecordsSource;
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface LineReport {
  line: number;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number | null;
  poNumber: string | null;
  ticketNumber: string | null;
  serviceDate: string | null;
}

export interface MatchLineReport {
  line: number;
  status: string;
  flag: string;
  reason: string;
  /** What production would store where the reader saw nothing. */
  storedAs: { quantity: number; unit: string; unitRate: number; poNumber: string | null };
  order: { id: string; orderNumber: string | null; poNumber: string | null; product: string } | null;
  candidateOrders: number;
  tickets: Array<{ id: string; ticketNumber: string | null }>;
  agreedRate: number | null;
  approvedTotal: number | null;
  rateDiscrepancy: number | null;
  quantityDiscrepancy: number | null;
  considered: { orders: number; tickets: number; rates: number; competingLines: number };
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface SampleReport {
  file: string;
  manifest: ManifestEntry | null;
  intake: { kind: AttachmentRecord['kind']; action: AttachmentRecord['action']; reason: string | null; bytes: number };
  pages: { count: number | null; plan: PagePlan['pages']; description: string; split: boolean; note: string | null } | null;
  spreadsheet: { sheets: number; characters: number } | null;
  reader: 'pre-extracted' | 'model';
  invoice: {
    supplierName: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    poNumber: string | null;
    totalAmount: number | null;
    readability: string;
    uncertainFields: string[];
    lines: LineReport[];
  } | null;
  fill: FillReport | null;
  totals: TotalsCheck | null;
  units: UnitReport | null;
  ticketPages: Array<{ page: number; ticketNumber: string | null; poNumber: string | null; quantity: number | null; unit: string | null; material: string | null; error?: string }>;
  supplier: {
    printed: string | null;
    /** How production would file it, or 'not checked' without related records. */
    resolution: SupplierResolution['how'] | 'from-manifest' | 'not checked';
    supplierId: string | null;
    supplierName: string | null;
    supplierType: string | null;
    note: string | null;
  } | null;
  matching: { lines: MatchLineReport[]; invoiceTotalCheck: InvoiceTotalCheck } | null;
  expectations: ExpectationResult[];
  warnings: string[];
  error: string | null;
}

export interface DryRunReport {
  generatedAt: string;
  dir: string;
  reader: 'pre-extracted' | 'model';
  relatedRecords: 'related.json' | 'loopback database' | 'none';
  /** Said in every report, so nobody mistakes it for a record of something done. */
  writes: 'none';
  samples: SampleReport[];
  summary: {
    files: number;
    invoicesRead: number;
    notRead: number;
    errors: number;
    headerFill: Array<{ field: string; filled: number; total: number }>;
    lineFill: Array<{ field: string; filled: number; total: number }>;
    unknownUnits: Array<{ unit: string; count: number; files: string[] }>;
    totals: Record<string, number>;
    statuses: Record<string, number>;
    flags: Record<string, number>;
    suppliersProductionWouldCreate: string[];
    missingFromManifest: string[];
  };
}

const iso = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1]!.toLowerCase() : '';
}

/** "invoice-77.pdf" page 3 -> "invoice-77-p3.pdf", as the inbox names a ticket page. */
function pageFileName(name: string, page: number): string {
  return `${name.replace(/\.[a-z0-9]+$/i, '')}-p${page}.pdf`;
}

function asString(value: unknown): string | null {
  if (value instanceof Date) return iso(value);
  return typeof value === 'string' && value.trim() ? value : null;
}

// ---------------------------------------------------------------------------
// Reading one sample
// ---------------------------------------------------------------------------

interface SampleReading {
  report: SampleReport;
  invoice: NormalizedInvoice | null;
  tickets: Array<{ page: number; ticket: NormalizedTicket }>;
  captured: ReaderSession['captured'];
}

async function loadFixture(dir: string, file: string): Promise<ExtractionFixture | null> {
  const fixturePath = extractionFixturePath(dir, file);
  if (!existsSync(fixturePath)) return null;
  return ExtractionFixtureSchema.parse(JSON.parse(await readFile(fixturePath, 'utf8')));
}

/**
 * Reads one sample the way the inbox reads an attachment (GmailService
 * fileDocument): judge the file by its bytes, sort its pages, file each
 * ticket page as a ticket, and read the invoice pages as one invoice.
 */
async function readSample(
  dir: string,
  file: string,
  manifest: ManifestEntry | null,
  options: DryRunOptions,
  deps: DryRunDeps
): Promise<SampleReading> {
  const { extraction } = deps;
  const bytes = await readFile(path.join(dir, file));
  const claimed = SAMPLE_EXTENSIONS[extensionOf(file)] ?? 'other';
  const record = classifyDownloaded(
    { name: file, mimeType: null, size: null, partId: null, kind: claimed, action: 'read', reason: null },
    bytes
  );

  const report: SampleReport = {
    file,
    manifest,
    intake: { kind: record.kind, action: record.action, reason: record.reason, bytes: bytes.length },
    pages: null,
    spreadsheet: null,
    reader: options.mode === 'ai' ? 'model' : 'pre-extracted',
    invoice: null,
    fill: null,
    totals: null,
    units: null,
    ticketPages: [],
    supplier: null,
    matching: null,
    expectations: [],
    warnings: [],
    error: null,
  };
  const reading: SampleReading = { report, invoice: null, tickets: [], captured: {} };
  if (record.action !== 'read') return reading;

  let session: ReaderSession;
  if (options.mode === 'ai') {
    if (!deps.liveProvider) throw new Error('Reading with the model needs a provider');
    session = recordingReader(deps.liveProvider);
  } else {
    let fixture: ExtractionFixture | null;
    try {
      fixture = await loadFixture(dir, file);
    } catch (error) {
      report.error = `${file}.extraction.json could not be used: ${(error as Error).message}`;
      return reading;
    }
    if (!fixture) {
      report.error = `No ${file}.extraction.json beside it. Run once without --no-ai (with --save-extractions) to read it with the model.`;
      return reading;
    }
    session = fixtureReader(fixture, file);
  }
  reading.captured = session.captured;
  const restore = extraction.setExtractionProviderForTests(session.provider);

  try {
    const storedName = storedFileName(file, bytes, record.kind);
    const mimeType = extraction.mimeTypeForFilename(storedName);

    if (record.kind === 'spreadsheet') {
      try {
        const readable = await extraction.readableDocument({ bytes, mimeType, filename: storedName });
        const text = readable.text ?? '';
        report.spreadsheet = { sheets: (text.match(/^# Sheet: /gm) ?? []).length, characters: text.length };
      } catch (error) {
        if (!(error instanceof ExtractionError)) throw error;
        report.intake = { ...report.intake, action: 'review', reason: `spreadsheet could not be read: ${error.message}` };
        return reading;
      }
    }

    const pageCount = record.kind === 'pdf' ? await pdfPageCount(bytes) : null;
    const splittable = pageCount !== null && pageCount > 1 && pageCount <= MAX_SPLIT_PAGES;
    let plan: PagePlan;
    let note: string | null = null;
    try {
      plan = planPages(await extraction.triageDocument(bytes, mimeType, file), splittable ? pageCount : null);
    } catch (error) {
      if (!(error instanceof ExtractionError) || error.retryable) throw error;
      if (record.kind === 'spreadsheet') {
        report.intake = { ...report.intake, action: 'review', reason: `spreadsheet could not be read: ${error.message}` };
        return reading;
      }
      plan = unsortedPlan();
      note = 'pages could not be sorted, so the whole file was read as an invoice';
    }
    report.pages = { count: pageCount, plan: plan.pages, description: describePages(plan.pages), split: plan.split, note };

    // A spreadsheet is never filed as a ticket: tickets are photos and scans.
    const ticketPages = record.kind === 'spreadsheet' ? [] : plan.ticketPages;
    for (const page of ticketPages) {
      const pageBytes = plan.split ? await extractPdfPages(bytes, [page]) : bytes;
      const name = plan.split ? pageFileName(file, page) : storedName;
      session.setPage(page);
      try {
        const ticket = await extraction.extractTicket(pageBytes, extraction.mimeTypeForFilename(name), name);
        reading.tickets.push({ page, ticket });
        report.ticketPages.push({
          page,
          ticketNumber: ticket.ticketNumber,
          poNumber: ticket.poNumber,
          quantity: ticket.quantity,
          unit: ticket.unit,
          material: ticket.material,
        });
      } catch (error) {
        if (!(error instanceof ExtractionError) || error.retryable) throw error;
        report.ticketPages.push({ page, ticketNumber: null, poNumber: null, quantity: null, unit: null, material: null, error: error.message });
      }
    }

    if (plan.invoicePages.length === 0) {
      report.intake = {
        ...report.intake,
        reason: plan.pages.some((p) => p.kind === 'credit_memo') ? 'credit memo: enter it by hand' : 'no invoice pages',
      };
      return reading;
    }

    const whole = !plan.split || plan.invoicePages.length === plan.pages.length;
    const invoiceBytes = whole ? bytes : await extractPdfPages(bytes, plan.invoicePages);
    const invoiceName = storedFileName(file, invoiceBytes, record.kind);
    session.setPage(plan.invoicePages[0] ?? 1);
    const invoice = await extraction.extractInvoice(invoiceBytes, extraction.mimeTypeForFilename(invoiceName), invoiceName);
    reading.invoice = invoice;

    const raw = rawInvoiceLines(session.captured);
    report.invoice = {
      supplierName: invoice.supplierName,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: iso(invoice.invoiceDate),
      poNumber: invoice.poNumber,
      totalAmount: invoice.totalAmount,
      readability: invoice.readability,
      uncertainFields: invoice.uncertainFields,
      lines: invoice.lineItems.map((line, index) => ({
        line: index + 1,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        amount: line.totalPrice,
        poNumber: line.poNumber,
        ticketNumber: asString(lineField(invoice, raw, index, 'ticketNumber')),
        serviceDate: asString(lineField(invoice, raw, index, 'serviceDate')),
      })),
    };
    report.fill = fillReport(invoice, raw);
    report.totals = totalsCheck(invoice);
    report.units = unitReport(invoice);
  } catch (error) {
    report.error =
      error instanceof ExtractionError && error.retryable
        ? `The reader is unavailable right now (${error.message}); run again later`
        : (error as Error).message;
  } finally {
    restore();
    report.warnings.push(...session.warnings);
  }

  if (options.mode === 'ai' && options.saveExtractions && Object.keys(session.captured).length > 0) {
    await writeFile(extractionFixturePath(dir, file), `${JSON.stringify(session.captured, null, 2)}\n`);
  }
  return reading;
}

// ---------------------------------------------------------------------------
// Supplier and matching
// ---------------------------------------------------------------------------

/**
 * The supplier the invoice is filed under. The printed name decides, as it
 * does in processInvoiceOcr. With no printed name, production keeps the
 * supplier the sender's address was registered to; the manifest's supplier
 * stands in for that here.
 */
function supplierFor(
  invoice: NormalizedInvoice,
  manifest: ManifestEntry | null,
  suppliers: RelatedSupplier[]
): NonNullable<SampleReport['supplier']> {
  const printed = invoice.supplierName;
  const resolution = resolveSupplierLikeProduction(printed, suppliers);
  if (resolution.how === 'exact' || resolution.how === 'contains' || resolution.how === 'fuzzy') {
    return {
      printed,
      resolution: resolution.how,
      supplierId: resolution.supplier.id,
      supplierName: resolution.supplier.name,
      supplierType: resolution.supplier.type,
      note:
        resolution.how === 'exact'
          ? null
          : `Filed under ${resolution.supplier.name} by a ${resolution.how} name match${resolution.how === 'fuzzy' ? ` (${resolution.similarity})` : ''}; check it is the right one`,
    };
  }
  if (resolution.how === 'would-create') {
    return {
      printed,
      resolution: 'would-create',
      supplierId: null,
      supplierName: null,
      supplierType: null,
      note:
        `Production would create a new supplier "${resolution.name}", which has no orders or rates` +
        (resolution.bestGuess ? `; the closest known is ${resolution.bestGuess.name} (${resolution.bestGuess.similarity})` : '') +
        '. Register the name (or rename the supplier) before go-live.',
    };
  }
  const fromManifest = manifest?.supplier ? resolveSupplierLikeProduction(manifest.supplier, suppliers) : null;
  if (fromManifest && 'supplier' in fromManifest) {
    return {
      printed,
      resolution: 'from-manifest',
      supplierId: fromManifest.supplier.id,
      supplierName: fromManifest.supplier.name,
      supplierType: fromManifest.supplier.type,
      note: 'No supplier name was read; filed under the sender, taken from the manifest',
    };
  }
  return {
    printed,
    resolution: 'none',
    supplierId: null,
    supplierName: null,
    supplierType: null,
    note: 'No supplier name was read and none is known for the sender',
  };
}

/**
 * The invoice date the engine is given. With none read, production keeps the
 * date the email was received (the ingest's placeholder), which for a sample
 * is today; the report warns when that happens, because rates and the
 * supplier's date window are then measured from the wrong day.
 */
function matchingDate(invoice: NormalizedInvoice): Date {
  return invoice.invoiceDate ?? new Date(new Date().toISOString().slice(0, 10));
}

function matchSample(reading: SampleReading, records: RelatedRecords): void {
  const { report, invoice } = reading;
  if (!invoice || !report.supplier) return;
  const supplierId = report.supplier.supplierId;
  const withTickets = withEmailedTickets(
    records,
    reading.tickets.map(({ page, ticket }) => ({
      page,
      ticketNumber: ticket.ticketNumber,
      poNumber: ticket.poNumber,
      quantity: ticket.quantity,
      unit: ticket.unit,
      material: ticket.material,
      ticketDate: ticket.ticketDate,
    })),
    supplierId,
    `sample:${report.file}`
  );
  if (!invoice.invoiceDate) {
    report.warnings.push('No invoice date was read; production would use the day it arrived, so today was used for matching');
  }
  const orderById = new Map(records.orders.map((order) => [order.id, order]));
  const ticketById = new Map(withTickets.tickets.map((ticket) => [ticket.id, ticket]));

  const lines: MatchLineReport[] = invoice.lineItems.map((item, index) => {
    const stored = storedLineLikeProduction(item, index, invoice.poNumber);
    const result = decideInvoiceLineDryRun(
      stored,
      { lineId: `sample:${report.file}#${index + 1}`, supplierId, invoiceDate: matchingDate(invoice) },
      withTickets
    );
    const order = result.decision.orderId ? orderById.get(result.decision.orderId) ?? null : null;
    return {
      line: index + 1,
      status: result.decision.status,
      flag: result.flag,
      reason: result.decision.reason,
      storedAs: { quantity: stored.quantity, unit: stored.unit, unitRate: stored.unitRate, poNumber: stored.poNumber },
      order: order ? { id: order.id, orderNumber: order.orderNumber, poNumber: order.poNumber, product: order.product } : null,
      candidateOrders: result.decision.candidateOrderIds.length,
      tickets: result.decision.ticketIds.map((id) => ({ id, ticketNumber: ticketById.get(id)?.ticketNumber ?? null })),
      agreedRate: result.decision.totals?.agreedRate ?? null,
      approvedTotal: result.approvedTotal,
      rateDiscrepancy: result.decision.totals?.rateDiscrepancy ?? null,
      quantityDiscrepancy: result.decision.totals?.quantityDiscrepancy ?? null,
      considered: result.considered,
      checks: result.decision.checks.map((check) => ({ name: check.name, passed: check.passed, detail: check.detail })),
    };
  });

  const invoiceTotalCheck = previewInvoiceTotalCheck(
    lines.map((line) => ({ description: invoice.lineItems[line.line - 1]!.description, quantity: line.storedAs.quantity, agreedRate: line.agreedRate })),
    // processInvoiceOcr keeps the ingest's placeholder total when none is read.
    invoice.totalAmount ?? 0
  );
  report.matching = { lines, invoiceTotalCheck };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function summarise(samples: SampleReport[], missingFromManifest: string[]): DryRunReport['summary'] {
  const read = samples.filter((sample) => sample.invoice !== null);
  const headerFields = new Map<string, { filled: number; total: number }>();
  const lineFields = new Map<string, { filled: number; total: number }>();
  for (const sample of read) {
    for (const { field, filled } of sample.fill!.header) {
      const entry = headerFields.get(field) ?? { filled: 0, total: 0 };
      headerFields.set(field, { filled: entry.filled + (filled ? 1 : 0), total: entry.total + 1 });
    }
    for (const { field, filled, total } of sample.fill!.lines) {
      const entry = lineFields.get(field) ?? { filled: 0, total: 0 };
      lineFields.set(field, { filled: entry.filled + filled, total: entry.total + total });
    }
  }

  const units = new Map<string, { count: number; files: Set<string> }>();
  for (const sample of read) {
    for (const { unit, lines } of sample.units!.unknown) {
      const entry = units.get(unit) ?? { count: 0, files: new Set<string>() };
      entry.count += lines.length;
      entry.files.add(sample.file);
      units.set(unit, entry);
    }
  }

  const matched = samples.flatMap((sample) => sample.matching?.lines ?? []);
  return {
    files: samples.length,
    invoicesRead: read.length,
    notRead: samples.filter((sample) => sample.invoice === null && sample.error === null).length,
    errors: samples.filter((sample) => sample.error !== null).length,
    headerFill: [...headerFields.entries()].map(([field, v]) => ({ field, ...v })),
    lineFill: [...lineFields.entries()].map(([field, v]) => ({ field, ...v })),
    unknownUnits: [...units.entries()]
      .map(([unit, v]) => ({ unit, count: v.count, files: [...v.files] }))
      .sort((a, b) => b.count - a.count),
    totals: tally(read.map((sample) => sample.totals!.verdict)),
    statuses: tally(matched.map((line) => line.status)),
    flags: tally(matched.map((line) => line.flag)),
    suppliersProductionWouldCreate: [
      ...new Set(samples.filter((s) => s.supplier?.resolution === 'would-create').map((s) => s.supplier!.printed!)),
    ],
    missingFromManifest,
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${path.basename(file)} could not be read: ${(error as Error).message}`);
  }
}

/** Refuses to read samples, or write a report, anywhere git would commit them. */
function assertNotCommittable(paths: string[]): void {
  const committable = paths.filter((target) => gitIgnoreState(target) === 'tracked-or-committable');
  if (committable.length > 0) {
    throw new Error(
      `Refusing to run: git would commit ${committable.map((p) => path.basename(p)).join(', ')}. ` +
        'Samples are client paperwork; keep them in CGC/backend/.samples/ (gitignored) or outside the repository.'
    );
  }
}

export async function runSampleDryRun(options: DryRunOptions, deps: DryRunDeps): Promise<DryRunReport> {
  const log = deps.log ?? (() => {});
  const dir = path.resolve(options.dir);
  if (!existsSync(dir) || !(await stat(dir)).isDirectory()) {
    throw new Error(`No samples folder at ${dir}. Create it (CGC/backend/.samples/ is gitignored) or pass --dir.`);
  }

  const manifestPath = path.join(dir, MANIFEST_FILE);
  const manifest = existsSync(manifestPath) ? SampleManifestSchema.parse(await readJson(manifestPath)) : null;
  const manifestByFile = new Map((manifest?.samples ?? []).map((entry) => [entry.file, entry]));

  const allFiles = await listSampleFiles(dir);
  const files = options.only.length > 0 ? allFiles.filter((file) => options.only.includes(file)) : allFiles;
  assertNotCommittable([
    ...files.map((file) => path.join(dir, file)),
    ...(options.saveExtractions ? files.map((file) => extractionFixturePath(dir, file)) : []),
    path.join(dir, REPORT_FILE),
  ]);

  let relatedSource: DryRunReport['relatedRecords'] = 'none';
  let records: RelatedRecords | null = null;
  const relatedPath =
    options.related.kind === 'file'
      ? path.resolve(options.related.path)
      : options.related.kind === 'auto' && existsSync(path.join(dir, RELATED_FILE))
        ? path.join(dir, RELATED_FILE)
        : null;
  if (relatedPath) {
    records = parseRelatedRecords(await readJson(relatedPath));
    relatedSource = 'related.json';
  }
  let dbSuppliers: RelatedSupplier[] | null = null;
  if (options.related.kind === 'db') {
    if (!deps.db) throw new Error('--db needs a loopback database');
    dbSuppliers = await deps.db.loadSuppliers();
    relatedSource = 'loopback database';
  }
  const suppliers = records?.suppliers ?? dbSuppliers;

  log(`Reading ${files.length} sample${files.length === 1 ? '' : 's'} in ${dir} (${options.mode === 'ai' ? 'with the model' : 'pre-extracted readings'})`);
  const readings: SampleReading[] = [];
  for (const file of files) {
    const reading = await readSample(dir, file, manifestByFile.get(file) ?? null, options, deps);
    if (reading.invoice) {
      reading.report.supplier = suppliers
        ? supplierFor(reading.invoice, reading.report.manifest, suppliers)
        : {
            printed: reading.invoice.supplierName,
            resolution: 'not checked',
            supplierId: null,
            supplierName: null,
            supplierType: null,
            note: 'No related records, so the supplier was not looked up',
          };
    }
    readings.push(reading);
  }

  if (options.related.kind === 'db' && deps.db && dbSuppliers) {
    const request: RecordsRequest = { poNumbers: [], supplierDates: [] };
    for (const { invoice, report, tickets } of readings) {
      if (!invoice) continue;
      for (const line of invoice.lineItems) {
        const po = line.poNumber ?? invoice.poNumber;
        if (po) request.poNumbers.push(po);
      }
      for (const { ticket } of tickets) if (ticket.poNumber) request.poNumbers.push(ticket.poNumber);
      if (report.supplier?.supplierId) request.supplierDates.push({ supplierId: report.supplier.supplierId, date: matchingDate(invoice) });
    }
    records = await deps.db.loadRecords(dbSuppliers, request);
  }

  for (const reading of readings) {
    if (records) matchSample(reading, records);
    const { report, invoice } = reading;
    if (invoice && report.manifest) {
      report.expectations = compareWithManifest(
        invoice,
        report.manifest,
        report.supplier?.supplierName ?? report.supplier?.printed ?? invoice.supplierName
      );
    }
    if (report.supplier?.supplierType === 'TRUCKING_COMPANY') {
      report.warnings.push(
        "Trucking lines are checked here by the material-line engine; the per-load check against the dispatcher's rate (WP12) is not part of this preview"
      );
    }
  }

  const samples = readings.map((reading) => reading.report);
  const report: DryRunReport = {
    generatedAt: new Date().toISOString(),
    dir,
    reader: options.mode === 'ai' ? 'model' : 'pre-extracted',
    relatedRecords: relatedSource,
    writes: 'none',
    samples,
    summary: summarise(samples, [...manifestByFile.keys()].filter((file) => !allFiles.includes(file))),
  };

  if (options.writeReport) {
    await writeFile(path.join(dir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

// ---------------------------------------------------------------------------
// The console summary
// ---------------------------------------------------------------------------

const money = (n: number | null): string =>
  n === null ? '-' : `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (filled: number, total: number): string => (total === 0 ? '-' : `${filled}/${total}`);

function totalsLine(totals: TotalsCheck): string {
  switch (totals.verdict) {
    case 'adds-up':
      return `lines ${money(totals.subtotal)}${totals.taxLines ? ` + tax lines ${money(totals.taxLines)}` : ''} = ${money(totals.printedTotal)}: adds up`;
    case 'adds-up-with-hst':
      return `lines ${money(totals.subtotal)} + 13% HST ${money(totals.impliedHst)} = ${money(totals.printedTotal)}: adds up`;
    case 'does-not-add-up':
      return `lines ${money(totals.subtotal)}${totals.taxLines ? ` + tax lines ${money(totals.taxLines)}` : ''}, printed total ${money(totals.printedTotal)}: DOES NOT ADD UP (off by ${money(totals.difference)})`;
    case 'incomplete':
      return `line${totals.linesWithoutAmount.length === 1 ? '' : 's'} ${totals.linesWithoutAmount.join(', ')} have no amount, so the total cannot be checked`;
    case 'no-total':
      return 'no total was read';
    case 'no-lines':
      return 'no lines were read';
  }
}

export function formatDryRun(report: DryRunReport): string {
  const out: string[] = [];
  out.push(`Sample dry run: ${report.dir}`);
  out.push(`Reader: ${report.reader}. Related records: ${report.relatedRecords}. Nothing was written anywhere.`);

  for (const sample of report.samples) {
    out.push('');
    const pages = sample.pages ? `, ${sample.pages.count ?? 1} page${(sample.pages.count ?? 1) === 1 ? '' : 's'}: ${sample.pages.description}` : '';
    out.push(`== ${sample.file} (${sample.intake.kind}${pages})`);
    if (sample.manifest?.alreadyPaid) out.push('   Already paid: never enter this invoice in production.');
    if (sample.intake.action !== 'read') out.push(`   Not read: ${sample.intake.reason}`);
    if (sample.pages?.note) out.push(`   Note: ${sample.pages.note}`);
    if (sample.spreadsheet) out.push(`   Spreadsheet: ${sample.spreadsheet.sheets} sheet(s), ${sample.spreadsheet.characters} characters sent to the reader`);
    if (sample.error) out.push(`   ERROR: ${sample.error}`);
    for (const ticket of sample.ticketPages) {
      out.push(
        ticket.error
          ? `   Ticket p${ticket.page}: not read (${ticket.error})`
          : `   Ticket p${ticket.page}: #${ticket.ticketNumber ?? '?'} PO ${ticket.poNumber ?? '?'} ${ticket.quantity ?? '?'} ${ticket.unit ?? '?'} ${ticket.material ?? ''}`.trimEnd()
      );
    }
    if (sample.invoice) {
      const inv = sample.invoice;
      if (sample.supplier) {
        const filed = sample.supplier.supplierName ? ` -> ${sample.supplier.supplierName} (${sample.supplier.resolution})` : ` (${sample.supplier.resolution})`;
        out.push(`   Supplier: "${sample.supplier.printed ?? '-'}"${filed}`);
        if (sample.supplier.note) out.push(`     ${sample.supplier.note}`);
      }
      out.push(`   Invoice: #${inv.invoiceNumber ?? '-'}  date ${inv.invoiceDate ?? '-'}  PO ${inv.poNumber ?? '-'}  total ${money(inv.totalAmount)}  (${inv.readability})`);
      const fill = sample.fill!;
      const missing = fill.header.filter((f) => !f.filled).map((f) => f.field);
      out.push(
        `   Read: header ${fill.header.length - missing.length}/${fill.header.length}${missing.length ? ` (missing ${missing.join(', ')})` : ''}; ` +
          `lines ${fill.lines.map((f) => `${f.field} ${pct(f.filled, f.total)}`).join(', ')}` +
          (fill.notReadByThisBuild.length ? `; not read by this build: ${fill.notReadByThisBuild.join(', ')}` : '')
      );
      if (inv.uncertainFields.length) out.push(`   Unsure: ${inv.uncertainFields.join(', ')}`);
      out.push(`   Totals: ${totalsLine(sample.totals!)}`);
      for (const a of sample.totals!.arithmetic) {
        out.push(`     line ${a.line}: quantity x price is ${money(a.quantityTimesPrice)} but the amount says ${money(a.amount)}`);
      }
      const units = sample.units!;
      if (units.unknown.length || units.missing.length) {
        out.push(
          `   Units: ${[
            ...units.unknown.map((u) => `"${u.unit}" not recognised (line ${u.lines.join(', ')})`),
            ...(units.missing.length ? [`no unit on line ${units.missing.join(', ')}`] : []),
          ].join('; ')}`
        );
      }
      const matching = new Map((sample.matching?.lines ?? []).map((line) => [line.line, line]));
      for (const line of inv.lines) {
        const m = matching.get(line.line);
        const read = `${line.description} | ${line.quantity ?? '?'} ${line.unit ?? '?'} @ ${line.unitPrice ?? '?'} = ${line.amount ?? '?'} | PO ${line.poNumber ?? inv.poNumber ?? '-'}` +
          (line.ticketNumber ? ` | ticket ${line.ticketNumber}` : '') +
          (line.serviceDate ? ` | ${line.serviceDate}` : '');
        out.push(`   Line ${line.line}: ${read}`);
        if (m) {
          const order = m.order ? `order ${m.order.orderNumber ?? m.order.id}` : `${m.candidateOrders} candidate order(s)`;
          out.push(`     -> ${m.status} / ${m.flag}: ${order}; ${m.tickets.length} ticket(s); agreed rate ${m.agreedRate ?? '-'}`);
          for (const check of m.checks.filter((c) => !c.passed)) out.push(`        x ${check.name}: ${check.detail}`);
        }
      }
      if (sample.matching?.invoiceTotalCheck.note) out.push(`   Invoice note production would write: ${sample.matching.invoiceTotalCheck.note}`);
    }
    for (const expectation of sample.expectations.filter((e) => !e.ok)) {
      out.push(`   Manifest: ${expectation.field} expected ${expectation.expected}, read ${expectation.found ?? '-'}`);
    }
    for (const warning of sample.warnings) out.push(`   Warning: ${warning}`);
  }

  const s = report.summary;
  out.push('');
  out.push('== Summary');
  out.push(`   ${s.files} file(s): ${s.invoicesRead} invoice(s) read, ${s.notRead} not read, ${s.errors} error(s)`);
  if (s.headerFill.length) out.push(`   Header fields: ${s.headerFill.map((f) => `${f.field} ${pct(f.filled, f.total)}`).join(', ')}`);
  if (s.lineFill.length) out.push(`   Line fields: ${s.lineFill.map((f) => `${f.field} ${pct(f.filled, f.total)}`).join(', ')}`);
  if (Object.keys(s.totals).length) out.push(`   Totals: ${Object.entries(s.totals).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (s.unknownUnits.length) {
    out.push(`   Units to confirm before any alias is added: ${s.unknownUnits.map((u) => `"${u.unit}" x${u.count}`).join(', ')}`);
  }
  if (Object.keys(s.statuses).length) out.push(`   Verdicts: ${Object.entries(s.statuses).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (Object.keys(s.flags).length) out.push(`   Flags: ${Object.entries(s.flags).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (s.suppliersProductionWouldCreate.length) out.push(`   Production would create new suppliers: ${s.suppliersProductionWouldCreate.join(', ')}`);
  if (s.missingFromManifest.length) out.push(`   In the manifest but not in the folder: ${s.missingFromManifest.join(', ')}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `Usage: npm run samples:dry-run -- [options]

  --dir <path>          samples folder (default: .samples, which is gitignored)
  --no-ai, --fixture    use <file>.extraction.json instead of the model (offline)
  --save-extractions    with the model, keep its readings as <file>.extraction.json
  --related <path>      orders, tickets and rates to match against (default: <dir>/related.json if present)
  --db                  read them from DATABASE_URL instead; loopback only, read only
  --no-match            skip the matching preview
  --only <file>         only this sample (repeatable)
  --no-report           do not write ${REPORT_FILE}
`;

export function parseArgs(argv: string[]): DryRunOptions | 'help' {
  const options: DryRunOptions = {
    dir: '.samples',
    mode: 'ai',
    saveExtractions: false,
    related: { kind: 'auto' },
    only: [],
    writeReport: true,
  };
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const take = (): string => {
      if (inline !== null) return inline;
      const next = value(i, flag);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--help':
      case '-h':
        return 'help';
      case '--dir':
        options.dir = take();
        break;
      case '--no-ai':
      case '--fixture':
        options.mode = 'fixture';
        break;
      case '--save-extractions':
        options.saveExtractions = true;
        break;
      case '--related':
        options.related = { kind: 'file', path: take() };
        break;
      case '--db':
        options.related = { kind: 'db' };
        break;
      case '--no-match':
        options.related = { kind: 'none' };
        break;
      case '--only':
        options.only.push(take());
        break;
      case '--no-report':
        options.writeReport = false;
        break;
      default:
        throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
    }
  }
  if (options.saveExtractions && options.mode === 'fixture') {
    throw new Error('--save-extractions only makes sense when reading with the model');
  }
  return options;
}

/**
 * Values the extraction modules check for at import but a dry run never
 * uses. Set before config/env.ts loads, so a .env holding real ones (the
 * main checkout's holds production's) is never what this process sees:
 * dotenv does not override a variable that is already set.
 */
function fillUnusedEnvironment(options: DryRunOptions): void {
  const unused: Record<string, string> = {
    JWT_SECRET: 'unused-by-the-sample-dry-run',
    SUPABASE_URL: 'https://unused.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'unused-by-the-sample-dry-run',
    SUPABASE_STORAGE_BUCKET: 'unused',
  };
  for (const [key, value] of Object.entries(unused)) process.env[key] = value;
  if (options.related.kind !== 'db') {
    process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
    process.env.DIRECT_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
  }
  if (options.mode === 'fixture') process.env.OPENAI_API_KEY ||= 'unused-by-the-sample-dry-run';
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return 0;
  }
  const options = parsed;

  // Checked first, before anything could load a .env file.
  let dbUrl: string | null = null;
  if (options.related.kind === 'db') {
    const { assertLoopbackDatabase } = await import('./sampleDryRun/loopbackRecords.js');
    dbUrl = assertLoopbackDatabase(process.env);
  }
  fillUnusedEnvironment(options);

  const extraction = await import('../services/extraction/extraction.service.js');
  let liveProvider: ExtractionProvider | undefined;
  if (options.mode === 'ai') {
    const { openaiExtractionProvider } = await import('../services/extraction/providers/openai.adapter.js');
    liveProvider = openaiExtractionProvider;
  }

  let disconnect: (() => Promise<void>) | null = null;
  let db: DbRecordsSource | undefined;
  if (dbUrl) {
    const { PrismaClient } = await import('@prisma/client');
    const loopback = await import('./sampleDryRun/loopbackRecords.js');
    // The URL that passed the loopback check is the one used, never one
    // Prisma would look up for itself.
    const client = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    disconnect = () => client.$disconnect();
    db = {
      loadSuppliers: () => loopback.inReadOnlyTransaction(client, (tx) => loopback.loadSuppliers(tx)),
      loadRecords: (suppliers, request) =>
        loopback.inReadOnlyTransaction(client, (tx) => loopback.loadRelatedRecordsFromDb(tx, suppliers, request)),
    };
  }

  try {
    const report = await runSampleDryRun(options, {
      extraction,
      ...(liveProvider ? { liveProvider } : {}),
      ...(db ? { db } : {}),
      log: (line) => console.log(line),
    });
    console.log(formatDryRun(report));
    if (options.writeReport) console.log(`\nReport: ${path.join(report.dir, REPORT_FILE)}`);
    return report.summary.errors > 0 ? 1 : 0;
  } finally {
    await disconnect?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(2);
    });
}
