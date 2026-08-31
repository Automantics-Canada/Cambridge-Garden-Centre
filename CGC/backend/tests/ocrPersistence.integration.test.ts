/**
 * What actually reaches the database.
 *
 * These run against a real PostgreSQL instance because the guarantees under test
 * are database guarantees: that an invoice and its lines are replaced together
 * or not at all, that an incomplete read cannot zero out values a person already
 * fixed, and that OCR cannot conjure a supplier row.
 *
 * The failure injection is a trigger rather than a mock. Stubbing the Prisma
 * client would prove the code calls `$transaction`; raising inside the second
 * line insert proves the transaction actually rolls the first one back.
 *
 * Requires a disposable database and explicit confirmation:
 *   CGC_TEST_CONFIRM_DISPOSABLE=1 DATABASE_URL=... npm run test:integration
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import type { ExtractionOutcome, InvoiceExtraction, TicketExtraction } from '../src/services/documentExtraction/types.js';
import { valid, missing } from '../src/services/documentExtraction/types.js';

const disposableConfirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';

// The document readers are replaced so these tests exercise persistence, not
// Textract. Everything below the readers is the real code path.
let invoiceOutcome: ExtractionOutcome<InvoiceExtraction>;
let ticketOutcome: ExtractionOutcome<TicketExtraction>;
let ticketReadCount = 0;

mock.module('../src/services/invoiceOcr.service.js', {
  namedExports: { extractInvoiceDocument: async () => invoiceOutcome },
});
mock.module('../src/services/ocr.service.js', {
  namedExports: {
    extractTicketDocument: async () => {
      ticketReadCount += 1;
      return ticketOutcome;
    },
  },
});

const { prisma } = await import('../src/db/prisma.js');
const { InvoiceService } = await import('../src/modules/invoices/invoice.service.js');
const { TicketService } = await import('../src/modules/tickets/ticket.service.js');
const { processOcrJob } = await import('../src/services/ocrJobProcessor.js');

const FAIL_MARKER = '__INJECTED_FAILURE__';

function textractField<T>(value: T) {
  return valid(value, 'TEXTRACT' as const, 0.99);
}

function invoiceLine(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    description: textractField('Granular A Gravel'),
    quantity: textractField(25),
    unit: textractField('tonnes'),
    unitRate: textractField(18.5),
    lineTotal: textractField(462.5),
    poNumber: textractField('447201'),
    ...overrides,
  } as InvoiceExtraction['lines'][number];
}

function completeInvoiceOutcome(
  lines = [invoiceLine()],
  overrides: Partial<InvoiceExtraction> = {}
): ExtractionOutcome<InvoiceExtraction> {
  return {
    fields: {
      supplierName: textractField('Northfield Aggregates Ltd'),
      invoiceNumber: textractField('INV-88213'),
      invoiceDate: textractField('2026-07-14'),
      poNumber: textractField('447201'),
      total: textractField(462.5),
      lines,
      ...overrides,
    },
    ocrText: 'Northfield Aggregates Ltd\nGranular A Gravel 25 tonnes 18.50 462.50',
    ocrConfidence: 0.98,
    issues: [],
    fallback: {
      used: false,
      reason: 'NOT_NEEDED',
      model: null,
      durationMs: null,
      promptTokens: null,
      completionTokens: null,
      requestedFields: [],
      acceptedFields: [],
    },
    complete: true,
  };
}

async function resetDatabase(): Promise<void> {
  if (!disposableConfirmed) {
    throw new Error('Refusing to clear a database without CGC_TEST_CONFIRM_DISPOSABLE=1');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "OcrJob", "InvoiceLineItem", "Invoice", "TicketOrderMatch", "Ticket", ' +
      '"Order", "Driver", "Supplier", "User" RESTART IDENTITY CASCADE'
  );
}

async function seedSupplier(name = 'Northfield Aggregates Ltd', emailDomains: string[] = []) {
  return prisma.supplier.create({
    data: { name, type: 'SUPPLIER', emailDomains, keywords: [] },
  });
}

async function seedInvoice(supplierId: string, overrides: Record<string, unknown> = {}) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'EXISTING-1',
      senderType: 'SUPPLIER',
      supplierId,
      invoiceDate: new Date('2026-06-01T00:00:00Z'),
      totalAmount: 900,
      currency: 'CAD',
      fileUrl: '/uploads/synthetic-invoice.pdf',
      emailFrom: 'billing@northfield-aggregates.test',
      emailSubject: 'Invoice',
      gmailMessageId: `gmail-${Math.random().toString(36).slice(2)}`,
      status: 'PENDING_REVIEW',
      ...overrides,
    },
  });

  const ocrJob = await prisma.ocrJob.create({
    data: { type: 'INVOICE', provider: 'AWS_TEXTRACT', status: 'PENDING', invoiceId: invoice.id },
  });

  return { invoice, ocrJob };
}

async function seedExistingLines(invoiceId: string) {
  await prisma.invoiceLineItem.create({
    data: {
      invoiceId,
      lineNumber: 1,
      description: 'Hand-corrected gravel line',
      quantity: 40,
      unit: 'tonnes',
      unitRate: 20,
      lineTotal: 800,
      flag: 'OK',
    },
  });
}

describe('OCR persistence PostgreSQL integration', { skip: !disposableConfirmed }, () => {
  before(async () => {
    // Raises inside whichever transaction tries to insert the marker line.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION cgc_test_fail_on_marker() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."description" = '${FAIL_MARKER}' THEN
          RAISE EXCEPTION 'injected line failure';
        END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS cgc_test_fail_trigger ON "InvoiceLineItem"');
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER cgc_test_fail_trigger BEFORE INSERT ON "InvoiceLineItem" ' +
        'FOR EACH ROW EXECUTE FUNCTION cgc_test_fail_on_marker()'
    );
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS cgc_test_fail_trigger ON "InvoiceLineItem"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS cgc_test_fail_on_marker()');
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  describe('invoice persistence is atomic', () => {
    it('writes the header and the complete set of lines together', async () => {
      const supplier = await seedSupplier();
      const { invoice } = await seedInvoice(supplier.id);
      await seedExistingLines(invoice.id);

      invoiceOutcome = completeInvoiceOutcome([
        invoiceLine(),
        invoiceLine({ description: textractField('Screened Sand'), lineTotal: textractField(462.5) }),
      ]);

      await InvoiceService.processInvoiceOcr(invoice.id);

      const after = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { lineItems: { orderBy: { lineNumber: 'asc' } }, ocrJobs: true },
      });

      assert.equal(after.invoiceNumber, 'INV-88213');
      assert.equal(Number(after.totalAmount), 462.5);
      assert.equal(after.OcrJobStatus, 'COMPLETED');
      assert.equal(after.lineItems.length, 2);
      assert.equal(after.lineItems[0]?.description, 'Granular A Gravel');
      // The OCR text itself, not a serialised provider response.
      assert.ok(after.ocrRawText?.includes('Granular A Gravel'));
      assert.ok(!after.ocrRawText?.includes('ExpenseDocuments'));
      assert.equal(after.ocrJobs[0]?.status, 'COMPLETED');
    });

    it('rolls back both the invoice and the lines when a later write fails', async () => {
      const supplier = await seedSupplier();
      const { invoice } = await seedInvoice(supplier.id);
      await seedExistingLines(invoice.id);

      // The first line inserts cleanly; the second trips the trigger.
      invoiceOutcome = completeInvoiceOutcome([
        invoiceLine(),
        invoiceLine({ description: textractField(FAIL_MARKER) }),
      ]);

      await assert.rejects(() => InvoiceService.processInvoiceOcr(invoice.id));

      const after = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { lineItems: true },
      });

      // The header never took the new values...
      assert.equal(after.invoiceNumber, 'EXISTING-1');
      assert.equal(Number(after.totalAmount), 900);
      // ...and the pre-existing line survived the deleteMany.
      assert.equal(after.lineItems.length, 1);
      assert.equal(after.lineItems[0]?.description, 'Hand-corrected gravel line');
      assert.equal(Number(after.lineItems[0]?.lineTotal), 800);
    });
  });

  describe('an incomplete extraction is held, not posted', () => {
    it('leaves every existing value intact and marks the job NEEDS_REVIEW', async () => {
      const supplier = await seedSupplier();
      const { invoice } = await seedInvoice(supplier.id);
      await seedExistingLines(invoice.id);

      invoiceOutcome = {
        ...completeInvoiceOutcome([invoiceLine({ unit: missing('No unit of measure on this line') })]),
        issues: [
          { field: 'lines.0.unit', code: 'MISSING_FIELD', message: 'No unit of measure on this line' },
        ],
        complete: false,
      };

      await InvoiceService.processInvoiceOcr(invoice.id);

      const after = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { lineItems: true, ocrJobs: true },
      });

      // Nothing that carries money moved.
      assert.equal(after.invoiceNumber, 'EXISTING-1');
      assert.equal(Number(after.totalAmount), 900);
      assert.notEqual(Number(after.totalAmount), 0, 'an unreadable invoice must never be zeroed');
      assert.equal(after.lineItems.length, 1);
      assert.equal(after.lineItems[0]?.description, 'Hand-corrected gravel line');
      assert.notEqual(after.lineItems[0]?.description, 'Unknown Item');
      assert.notEqual(after.lineItems[0]?.unit, 'ea');

      assert.equal(after.OcrJobStatus, 'NEEDS_REVIEW');
      const job = after.ocrJobs[0];
      assert.equal(job?.status, 'NEEDS_REVIEW');
      assert.ok((job?.reviewReasons ?? []).some(reason => reason.includes('lines.0.unit')));
      assert.equal(job?.errorMessage, null, 'awaiting review is not a failure');
    });

    it('persists provenance, confidence and fallback state on the job', async () => {
      const supplier = await seedSupplier();
      const { invoice } = await seedInvoice(supplier.id);

      invoiceOutcome = {
        ...completeInvoiceOutcome([invoiceLine({ unit: valid('tonnes', 'GROQ', 0.6) })]),
        issues: [
          { field: 'lines.0.unit', code: 'FALLBACK_SOURCED', message: 'Read by the fallback model' },
        ],
        fallback: {
          used: true,
          reason: 'REQUESTED',
          model: 'openai/gpt-oss-20b',
          durationMs: 412,
          promptTokens: 900,
          completionTokens: 20,
          requestedFields: ['lines.0.unit'],
          acceptedFields: ['lines.0.unit'],
        },
        complete: false,
      };

      await InvoiceService.processInvoiceOcr(invoice.id);

      const job = await prisma.ocrJob.findFirstOrThrow({ where: { invoiceId: invoice.id } });

      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.equal(job.fallbackUsed, true);
      assert.equal(job.structuredModel, 'openai/gpt-oss-20b');
      assert.equal(job.structuredProvider, 'AWS_TEXTRACT_DETERMINISTIC');
      assert.equal(job.extractionConfidence, 0.98);
      // The OCR provider is unchanged: Groq only fills fields, it does not read pages.
      assert.equal(job.provider, 'AWS_TEXTRACT');

      const raw = job.rawResponse as any;
      assert.equal(raw.fields['lines.0.unit'].source, 'GROQ');
      assert.equal(raw.fields['total'].source, 'TEXTRACT');
      assert.equal(raw.fallback.used, true);
    });
  });

  describe('OCR cannot invent or guess a supplier', () => {
    it('does not create a supplier for a name nothing matches', async () => {
      const supplier = await seedSupplier('Northfield Aggregates Ltd');
      const { invoice } = await seedInvoice(supplier.id);

      invoiceOutcome = completeInvoiceOutcome(undefined, {
        supplierName: textractField('Totally Unheard Of Quarries Inc'),
      });

      await InvoiceService.processInvoiceOcr(invoice.id);

      const suppliers = await prisma.supplier.findMany();
      assert.equal(suppliers.length, 1, 'OCR must never create a supplier row');

      const after = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { ocrJobs: true },
      });
      assert.equal(after.supplierId, supplier.id, 'the existing supplier is left in place');
      assert.equal(after.OcrJobStatus, 'NEEDS_REVIEW');
      assert.ok(
        (after.ocrJobs[0]?.reviewReasons ?? []).some(reason => reason.includes('supplierName'))
      );
    });

    it('does not fuzzily attach a near-miss supplier name', async () => {
      // "Northfeild Aggregate" would clear the old 0.75 similarity bar and be
      // attached silently. It must now only ever be a suggestion.
      const right = await seedSupplier('Northfield Aggregates Ltd');
      const holding = await seedSupplier('Unidentified supplier');
      const { invoice } = await seedInvoice(holding.id);

      invoiceOutcome = completeInvoiceOutcome(undefined, {
        supplierName: textractField('Northfeild Aggregate'),
      });

      await InvoiceService.processInvoiceOcr(invoice.id);

      const after = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { ocrJobs: true },
      });

      assert.equal(after.supplierId, holding.id, 'a close name must not be attached automatically');
      assert.notEqual(after.supplierId, right.id);

      const raw = after.ocrJobs[0]?.rawResponse as any;
      assert.equal(raw.supplierMatch.method, 'SUGGESTED');
      assert.equal(raw.supplierMatch.suggestion.name, 'Northfield Aggregates Ltd');
    });

    it('attaches a supplier on an exact name match', async () => {
      const right = await seedSupplier('Northfield Aggregates Ltd');
      const holding = await seedSupplier('Unidentified supplier');
      const { invoice } = await seedInvoice(holding.id);

      invoiceOutcome = completeInvoiceOutcome();

      await InvoiceService.processInvoiceOcr(invoice.id);

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      assert.equal(after.supplierId, right.id);
      assert.equal(after.OcrJobStatus, 'COMPLETED');
    });

    it('refuses to choose when two suppliers share the name', async () => {
      await seedSupplier('Northfield Aggregates Ltd');
      await seedSupplier('Northfield Aggregates Ltd');
      const holding = await seedSupplier('Unidentified supplier');
      const { invoice } = await seedInvoice(holding.id);

      invoiceOutcome = completeInvoiceOutcome();

      await InvoiceService.processInvoiceOcr(invoice.id);

      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      assert.equal(after.supplierId, holding.id);
      assert.equal(after.OcrJobStatus, 'NEEDS_REVIEW');
    });
  });

  describe('ticket auto-linking', () => {
    async function seedTicket(driverId: string | null) {
      const ticket = await prisma.ticket.create({
        data: {
          source: 'WHATSAPP',
          imageUrl: '/uploads/synthetic-ticket.png',
          ocrRawText: '',
          ocrConfidence: 0,
          status: 'UNLINKED',
          driverId,
        },
      });
      const ocrJob = await prisma.ocrJob.create({
        data: { type: 'TICKET', provider: 'AWS_TEXTRACT', status: 'PENDING', ticketId: ticket.id },
      });
      return { ticket, ocrJob };
    }

    async function seedOrder(driverId: string, supplierId: string, spruceOrderId: string) {
      return prisma.order.create({
        data: {
          spruceOrderId,
          poNumber: '447201',
          customerName: 'Synthetic Customer',
          product: 'Granular A Gravel',
          quantity: 25,
          unit: 'tonnes',
          supplierId,
          orderDate: new Date('2026-07-01T00:00:00Z'),
          driverId,
        },
      });
    }

    function ticketOutcomeFor(complete: boolean): ExtractionOutcome<TicketExtraction> {
      return {
        fields: {
          supplierName: textractField('Northfield Aggregates Ltd'),
          ticketNumber: textractField('550412'),
          ticketDate: textractField('2026-07-14'),
          poNumber: textractField('447201'),
          material: textractField('Granular A Gravel'),
          quantity: textractField(24.5),
          unit: textractField('tonnes'),
        },
        ocrText: 'Northfield Aggregates Ltd\nNet Weight 24.50 tonnes',
        ocrConfidence: 0.96,
        issues: [],
        fallback: {
          used: false,
          reason: 'NOT_NEEDED',
          model: null,
          durationMs: null,
          promptTokens: null,
          completionTokens: null,
          requestedFields: [],
          acceptedFields: [],
        },
        complete,
      };
    }

    it('links a ticket whose PO matches exactly one order for that driver', async () => {
      const supplier = await seedSupplier();
      const driver = await prisma.driver.create({
        data: { name: 'Synthetic Driver', phone: '+15550000001' },
      });
      const order = await seedOrder(driver.id, supplier.id, 'SPRUCE-1');
      const { ticket } = await seedTicket(driver.id);

      ticketOutcome = ticketOutcomeFor(true);

      await TicketService.processTicketOcr(ticket.id);

      const after = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: { orderMatches: true, ocrJobs: true },
      });

      assert.equal(after.status, 'LINKED');
      assert.equal(after.linkedOrderId, order.id);
      assert.equal(after.linkMethod, 'AUTO');
      assert.equal(after.orderMatches[0]?.matchMethod, 'AUTO_PO');
      assert.equal(after.supplierId, supplier.id);
      assert.equal(after.ocrJobs[0]?.status, 'COMPLETED');
    });

    it('leaves an ambiguous PO unlinked', async () => {
      const supplier = await seedSupplier();
      const driver = await prisma.driver.create({
        data: { name: 'Synthetic Driver', phone: '+15550000002' },
      });
      await seedOrder(driver.id, supplier.id, 'SPRUCE-A');
      await seedOrder(driver.id, supplier.id, 'SPRUCE-B');
      const { ticket } = await seedTicket(driver.id);

      ticketOutcome = ticketOutcomeFor(true);

      await TicketService.processTicketOcr(ticket.id);

      const after = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: { orderMatches: true, ocrJobs: true },
      });

      assert.equal(after.status, 'UNLINKED');
      assert.equal(after.linkedOrderId, null);
      assert.equal(after.orderMatches.length, 0);
      assert.equal(after.ocrJobs[0]?.status, 'NEEDS_REVIEW');
    });

    it('does not auto-link a ticket that no driver uploaded', async () => {
      const supplier = await seedSupplier();
      const driver = await prisma.driver.create({
        data: { name: 'Synthetic Driver', phone: '+15550000003' },
      });
      await seedOrder(driver.id, supplier.id, 'SPRUCE-C');
      const { ticket } = await seedTicket(null);

      ticketOutcome = ticketOutcomeFor(true);

      await TicketService.processTicketOcr(ticket.id);

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      assert.equal(after.status, 'UNLINKED');
      assert.equal(after.linkedOrderId, null);
    });

    it('never creates a supplier from a ticket', async () => {
      const driver = await prisma.driver.create({
        data: { name: 'Synthetic Driver', phone: '+15550000004' },
      });
      const { ticket } = await seedTicket(driver.id);

      ticketOutcome = ticketOutcomeFor(true);

      await TicketService.processTicketOcr(ticket.id);

      assert.equal(await prisma.supplier.count(), 0);
      const after = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: { ocrJobs: true },
      });
      assert.equal(after.supplierId, null);
      assert.equal(after.ocrJobs[0]?.status, 'NEEDS_REVIEW');
    });

    it('keeps all existing business values when the extraction needs review', async () => {
      const supplier = await seedSupplier();
      const driver = await prisma.driver.create({
        data: { name: 'Synthetic Driver', phone: '+15550000005' },
      });
      const { ticket } = await seedTicket(driver.id);
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { material: 'Corrected by hand', unit: 'tonnes', quantity: 30 },
      });

      ticketOutcome = {
        ...ticketOutcomeFor(false),
        fields: {
          ...ticketOutcomeFor(false).fields,
          material: missing('No material description on the ticket'),
          unit: missing('No unit of measure on the ticket'),
        },
        issues: [{ field: 'unit', code: 'MISSING_FIELD', message: 'No unit of measure on the ticket' }],
      };

      await TicketService.processTicketOcr(ticket.id);

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      assert.equal(after.material, 'Corrected by hand');
      assert.equal(after.unit, 'tonnes', 'an unreadable unit must not overwrite a known one');
      assert.notEqual(after.unit, 'ea');
      assert.equal(Number(after.quantity), 30, 'no candidate field is persisted before review');
      void supplier;
    });

    it('does not persist or auto-link Groq-sourced ticket candidates', async () => {
      const supplier = await seedSupplier();
      const driver = await prisma.driver.create({
        data: { name: 'Synthetic Driver', phone: '+15550000006' },
      });
      await seedOrder(driver.id, supplier.id, 'SPRUCE-GROQ');
      const { ticket } = await seedTicket(driver.id);

      ticketOutcome = {
        ...ticketOutcomeFor(false),
        fields: {
          ...ticketOutcomeFor(false).fields,
          supplierName: valid(supplier.name, 'GROQ', 0.6),
          poNumber: valid('447201', 'GROQ', 0.6),
          quantity: valid(24.5, 'GROQ', 0.6),
        },
        issues: [
          { field: 'supplierName', code: 'FALLBACK_SOURCED', message: 'Fallback candidate' },
          { field: 'poNumber', code: 'FALLBACK_SOURCED', message: 'Fallback candidate' },
          { field: 'quantity', code: 'FALLBACK_SOURCED', message: 'Fallback candidate' },
        ],
        fallback: {
          used: true,
          reason: 'REQUESTED',
          model: 'openai/gpt-oss-20b',
          durationMs: 1,
          promptTokens: 10,
          completionTokens: 3,
          requestedFields: ['supplierName', 'poNumber', 'quantity'],
          acceptedFields: ['supplierName', 'poNumber', 'quantity'],
        },
      };

      await TicketService.processTicketOcr(ticket.id);

      const after = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: { orderMatches: true, ocrJobs: true },
      });
      assert.equal(after.supplierId, null);
      assert.equal(after.poNumber, null);
      assert.equal(after.quantity, null);
      assert.equal(after.linkedOrderId, null);
      assert.equal(after.status, 'UNLINKED');
      assert.equal(after.orderMatches.length, 0);
      assert.equal(after.ocrJobs[0]?.status, 'NEEDS_REVIEW');
      assert.deepEqual(
        (after.ocrJobs[0]?.rawResponse as any)?.autoLink,
        { linked: false, method: null },
        'provenance must describe the committed state, not a rejected candidate match'
      );
    });

    it('claims a pending job once across concurrent processors', async () => {
      const supplier = await seedSupplier();
      const driver = await prisma.driver.create({
        data: { name: 'Synthetic Driver', phone: '+15550000007' },
      });
      await seedOrder(driver.id, supplier.id, 'SPRUCE-CLAIM');
      const { ocrJob } = await seedTicket(driver.id);
      ticketOutcome = ticketOutcomeFor(true);
      ticketReadCount = 0;

      await Promise.all([processOcrJob(ocrJob.id), processOcrJob(ocrJob.id)]);

      const job = await prisma.ocrJob.findUniqueOrThrow({ where: { id: ocrJob.id } });
      assert.equal(ticketReadCount, 1);
      assert.equal(job.attempts, 1);
      assert.equal(job.status, 'COMPLETED');
    });
  });

  describe('stuck job reporting', () => {
    it('separates documents awaiting review from documents that failed', async () => {
      const { getStuckOcrJobs } = await import('../src/services/ocrJobProcessor.js');
      const supplier = await seedSupplier();
      const { invoice: failedInvoice, ocrJob: failedJob } = await seedInvoice(supplier.id);
      const { invoice: reviewInvoice, ocrJob: reviewJob } = await seedInvoice(supplier.id);

      await prisma.ocrJob.update({
        where: { id: failedJob.id },
        data: { status: 'FAILED', errorMessage: 'Textract detected no text', finishedAt: new Date() },
      });
      await prisma.ocrJob.update({
        where: { id: reviewJob.id },
        data: {
          status: 'NEEDS_REVIEW',
          reviewReasons: ['lines.0.unit: No unit of measure on this line'],
          finishedAt: new Date(),
        },
      });

      const report = await getStuckOcrJobs();

      assert.equal(report.count, 1);
      assert.equal(report.jobs[0]?.invoiceId, failedInvoice.id);
      assert.equal(report.needsReviewCount, 1);
      assert.equal(report.needsReview[0]?.invoiceId, reviewInvoice.id);
      assert.deepEqual(report.needsReview[0]?.reviewReasons, [
        'lines.0.unit: No unit of measure on this line',
      ]);
    });
  });
});
