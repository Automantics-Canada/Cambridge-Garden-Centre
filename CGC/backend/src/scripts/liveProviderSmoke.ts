import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { assertDisposableQaDatabase } from './qaGuard.js';

const mode = process.argv[2] || 'parent';

function configureQaEnvironment(): void {
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_DRIVER = 'local';
  process.env.DATABASE_URL ||= 'postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_integration';
  process.env.DIRECT_URL ||= process.env.DATABASE_URL;
  process.env.JWT_SECRET ||= 'qa-only-jwt-secret-never-deploy';
  process.env.INTERNAL_SHARED_SECRET ||= 'qa-only-internal-secret-never-deploy';
  process.env.SUPABASE_URL ||= 'https://qa-local.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'qa-local-placeholder';
  process.env.SUPABASE_STORAGE_BUCKET ||= 'qa-local';
}

async function runTextract(invoiceUrl: string, ticketUrl: string): Promise<void> {
  process.env.GROQ_FALLBACK_ENABLED = 'false';
  const [{ extractInvoiceDocument }, { extractTicketDocument }] = await Promise.all([
    import('../services/invoiceOcr.service.js'),
    import('../services/ocr.service.js'),
  ]);

  const invoice = await extractInvoiceDocument({ fileUrl: invoiceUrl, jobId: 'qa-live-invoice' });
  const ticket = await extractTicketDocument({ imageUrl: ticketUrl, jobId: 'qa-live-ticket' });

  assert(invoice.ocrText.trim(), 'Textract invoice result must contain OCR text');
  assert(ticket.ocrText.trim(), 'Textract ticket result must contain OCR text');
  assert(invoice.fields.invoiceNumber.value || invoice.fields.total.value != null,
    'Textract invoice smoke must resolve an invoice identifier or total');
  assert(ticket.fields.ticketNumber.value || ticket.fields.quantity.value != null,
    'Textract ticket smoke must resolve a ticket identifier or net quantity');
  assert.equal(invoice.fallback.used, false);
  assert.equal(ticket.fallback.used, false);

  console.log(JSON.stringify({
    provider: 'AWS_TEXTRACT',
    invoiceRead: true,
    ticketRead: true,
    fallbackDisabled: true,
  }));
}

async function runGroq(): Promise<void> {
  process.env.GROQ_FALLBACK_ENABLED = 'true';
  const [{ finaliseTicketExtraction }, { missing, valid }] = await Promise.all([
    import('../services/documentExtraction/mergeExtraction.js'),
    import('../services/documentExtraction/types.js'),
  ]);

  const outcome = await finaliseTicketExtraction({
    documentType: 'TICKET',
    jobId: 'qa-live-groq',
    ocrConfidence: 0.95,
    ocrText: [
      'QA AGGREGATES LTD',
      'Ticket Number: QA-LIVE-T-1',
      'Date: 08/23/2026',
      'PO: 447201',
      'Material: Granular A Gravel',
      'Net Weight: 25.00',
      'Unit: tonnes',
      'Contact: qa-contact@example.test',
      'Portal: https://qa-documents.example.test/signed-link',
    ].join('\n'),
    extraction: {
      supplierName: valid('QA AGGREGATES LTD', 'DETERMINISTIC', 0.99),
      ticketNumber: valid('QA-LIVE-T-1', 'DETERMINISTIC', 0.99),
      ticketDate: valid('2026-08-23', 'DETERMINISTIC', 0.99),
      poNumber: valid('447201', 'DETERMINISTIC', 0.99),
      material: valid('Granular A Gravel', 'DETERMINISTIC', 0.99),
      quantity: valid(25, 'DETERMINISTIC', 0.99),
      unit: missing('Sanitized smoke deliberately leaves this unresolved'),
    },
  });

  assert.deepEqual(outcome.fallback.requestedFields, ['unit'],
    'Groq must receive only the unresolved field');
  assert.deepEqual(outcome.fallback.acceptedFields, ['unit']);
  assert.equal(outcome.fields.unit.source, 'GROQ');
  assert.equal(outcome.complete, false, 'fallback values must remain review candidates');
  assert(outcome.issues.some(issue => issue.code === 'FALLBACK_SOURCED'));

  console.log(JSON.stringify({
    provider: 'GROQ',
    requestedFields: outcome.fallback.requestedFields,
    acceptedFields: outcome.fallback.acceptedFields,
    reviewRequired: !outcome.complete,
    model: outcome.fallback.model,
  }));
}

function runChild(childMode: string, args: string[], environment: NodeJS.ProcessEnv): void {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('src/scripts/liveProviderSmoke.ts'),
      childMode,
      ...args,
    ],
    { cwd: process.cwd(), env: environment, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${childMode} smoke exited with ${result.status}`);
}

async function svgPng(lines: string[]): Promise<Buffer> {
  const text = lines.map((line, index) =>
    `<text x="70" y="${100 + index * 54}" font-family="Arial" font-size="30" fill="#111">${line}</text>`
  ).join('');
  return sharp(Buffer.from(
    `<svg width="1400" height="1100" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${text}</svg>`,
  )).png().toBuffer();
}

async function parent(): Promise<void> {
  if (process.env.CGC_LIVE_OCR_TESTS !== '1') {
    throw new Error('Refusing paid provider calls without CGC_LIVE_OCR_TESTS=1');
  }
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is required for the live provider smoke');
  }

  assertDisposableQaDatabase();
  const { prisma } = await import('../db/prisma.js');
  const before = await Promise.all([
    prisma.invoice.count(),
    prisma.ticket.count(),
    prisma.order.count(),
  ]);

  const fixtureId = `live-smoke-${randomUUID()}`;
  const fixtureRoot = path.resolve(process.cwd(), 'uploads', fixtureId);
  await fs.mkdir(fixtureRoot, { recursive: true });
  try {
    await Promise.all([
      fs.writeFile(path.join(fixtureRoot, 'invoice.png'), await svgPng([
        'QA AGGREGATES LTD', 'INVOICE', 'Invoice Number: QA-LIVE-1001',
        'Invoice Date: 08/23/2026', 'PO Number: 447201',
        'Granular A Gravel 25 tonnes at $18.50', 'Subtotal: $462.50',
        'HST: $60.13', 'Total: $522.63',
      ])),
      fs.writeFile(path.join(fixtureRoot, 'ticket.png'), await svgPng([
        'QA AGGREGATES LTD', 'WEIGH TICKET', 'Ticket Number: QA-LIVE-T-1',
        'Date: 08/23/2026', 'PO: 447201', 'Material: Granular A Gravel',
        'Gross Weight: 32.50 tonnes', 'Tare Weight: 7.50 tonnes',
        'Net Weight: 25.00 tonnes',
      ])),
    ]);

    const commonEnv = { ...process.env, NODE_ENV: 'test', STORAGE_DRIVER: 'local' };
    runChild('textract', [
      `/uploads/${fixtureId}/invoice.png`,
      `/uploads/${fixtureId}/ticket.png`,
    ], { ...commonEnv, GROQ_FALLBACK_ENABLED: 'false' });
    runChild('groq', [], { ...commonEnv, GROQ_FALLBACK_ENABLED: 'true' });

    const after = await Promise.all([
      prisma.invoice.count(),
      prisma.ticket.count(),
      prisma.order.count(),
    ]);
    assert.deepEqual(after, before, 'live extraction smoke must not mutate business records');
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

configureQaEnvironment();

if (mode === 'textract') {
  await runTextract(process.argv[3]!, process.argv[4]!);
} else if (mode === 'groq') {
  await runGroq();
} else {
  await parent();
}
