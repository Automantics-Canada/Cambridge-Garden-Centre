/**
 * The orchestration guarantees.
 *
 * This is the file to read to understand what the pipeline promises:
 *
 *   - a clean document costs nothing, because the fallback is never called;
 *   - an unclean one costs exactly one request, never one per field;
 *   - the fallback is only ever offered the fields that failed;
 *   - a value it returns cannot displace a value that validated confidently;
 *   - anything it returns that does not validate is dropped, not stored;
 *   - and any of that leaves the document NEEDS_REVIEW rather than COMPLETED.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { env } from '../src/config/env.js';
import { __setGroqClientForTests } from '../src/services/documentExtraction/groqFallback.service.js';
import {
  buildInvoiceProvenance,
  finaliseInvoiceExtraction,
  finaliseTicketExtraction,
  summariseReviewReasons,
} from '../src/services/documentExtraction/mergeExtraction.js';
import {
  extractInvoiceFromExpense,
  getOcrTextFromExpense,
} from '../src/services/documentExtraction/invoiceExtractor.js';
import { extractTicketFromText } from '../src/services/documentExtraction/ticketExtractor.js';
import { isTrusted } from '../src/services/documentExtraction/types.js';
import {
  analyzeExpenseResponse,
  cleanInvoiceResponse,
  cleanTicketText,
} from './fixtures/ocrDocuments.js';

const NOW = new Date('2026-07-20T00:00:00Z');

function stubClient(handler: (params: any) => unknown) {
  const create = mock.fn(async (params: any) => handler(params));
  __setGroqClientForTests({ chat: { completions: { create } } } as never);
  return create;
}

function completion(values: Record<string, string | null>) {
  return {
    choices: [{ message: { content: JSON.stringify(values) } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  };
}

/** Answer every field the request asked about with the same value. */
function answerAll(value: string) {
  return (params: any) => {
    const paths: string[] = params.response_format.json_schema.schema.required;
    return completion(Object.fromEntries(paths.map(path => [path, value])));
  };
}

function invoiceFrom(response: ReturnType<typeof analyzeExpenseResponse>) {
  const ocrText = getOcrTextFromExpense(response);
  return {
    extraction: extractInvoiceFromExpense({ response, ocrText, now: NOW }),
    ocrText,
  };
}

const originalEnv = { enabled: env.groqFallbackEnabled, key: env.groqApiKey };

beforeEach(() => {
  (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = true;
  (env as { groqApiKey: string }).groqApiKey = 'test-only-key';
});

afterEach(() => {
  (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = originalEnv.enabled;
  (env as { groqApiKey: string }).groqApiKey = originalEnv.key;
  __setGroqClientForTests(null);
  mock.restoreAll();
});

describe('a complete deterministic read', () => {
  it('never calls the fallback', async () => {
    const create = stubClient(answerAll('should not be reached'));
    const { extraction, ocrText } = invoiceFrom(cleanInvoiceResponse());

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-clean',
    });

    assert.equal(create.mock.callCount(), 0, 'a clean invoice must cost nothing');
    assert.equal(outcome.fallback.used, false);
    assert.equal(outcome.fallback.reason, 'NOT_NEEDED');
    assert.equal(outcome.complete, true);
    assert.deepEqual(outcome.issues, []);
  });

  it('keeps the OCR text separate from the fields', async () => {
    const { extraction, ocrText } = invoiceFrom(cleanInvoiceResponse());
    stubClient(answerAll('x'));

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-clean',
    });

    assert.ok(outcome.ocrText.includes('Northfield Aggregates Ltd'));
    assert.equal(outcome.ocrConfidence, 0.99);
  });

  it('does not call fallback for optional fields that are simply absent', async () => {
    const create = stubClient(answerAll('should not be reached'));
    const response = cleanInvoiceResponse();
    const document = response.ExpenseDocuments?.[0];
    if (document) {
      document.SummaryFields = document.SummaryFields?.filter(
        field => field.Type?.Text !== 'PO_NUMBER'
      );
      document.Blocks = document.Blocks?.filter(
        block => !/\b(?:p\.?\s*o\.?|purchase\s+order)\b/i.test(block.Text ?? '')
      );
    }
    const { extraction, ocrText } = invoiceFrom(response);

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-optional-po-absent',
    });

    assert.equal(extraction.poNumber.state, 'MISSING');
    assert.equal(extraction.lines[0]?.poNumber.state, 'MISSING');
    assert.equal(create.mock.callCount(), 0);
    assert.equal(outcome.complete, true);
    assert.deepEqual(outcome.issues, []);
  });
});

describe('an incomplete deterministic read', () => {
  const incompleteResponse = () =>
    analyzeExpenseResponse({
      summary: [
        { type: 'VENDOR_NAME', text: 'Northfield Aggregates Ltd' },
        { type: 'INVOICE_RECEIPT_ID', text: 'INV-88213' },
        { type: 'INVOICE_RECEIPT_DATE', text: '2026-07-14' },
        { type: 'TOTAL', text: '462.50', currency: 'CAD' },
      ],
      lineItems: [
        {
          item: 'Granular A Gravel',
          quantity: '25',
          unitPrice: '18.50',
          price: '462.50',
          // No unit anywhere: the field Textract could not supply.
          expenseRow: 'Granular A Gravel 25 18.50 462.50',
        },
      ],
      blocks: ['Northfield Aggregates Ltd', 'Granular A Gravel 25 18.50 462.50', 'TOTAL 462.50'],
    });

  it('issues exactly one request, for exactly the unresolved fields', async () => {
    const create = stubClient(answerAll('tonnes'));
    const { extraction, ocrText } = invoiceFrom(incompleteResponse());

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-gap',
    });

    assert.equal(create.mock.callCount(), 1, 'one request per document, never one per field');

    const requested: string[] = (create.mock.calls[0]?.arguments[0] as any).response_format.json_schema
      .schema.required;
    assert.ok(requested.includes('lines.0.unit'), 'the unresolved unit must be asked about');
    assert.ok(!requested.includes('total'), 'a confidently read total must not be asked about');
    assert.ok(!requested.includes('invoiceNumber'));
    assert.deepEqual(outcome.fallback.acceptedFields, ['lines.0.unit']);
  });

  it('fills the eligible field and leaves the trusted ones untouched', async () => {
    stubClient(answerAll('tonnes'));
    const { extraction, ocrText } = invoiceFrom(incompleteResponse());

    const before = {
      total: extraction.total.value,
      invoiceNumber: extraction.invoiceNumber.value,
      quantity: extraction.lines[0]?.quantity.value,
    };

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-gap',
    });

    const line = outcome.fields.lines[0];
    assert.equal(line?.unit.value, 'tonnes');
    assert.equal(line?.unit.source, 'GROQ');

    // Everything that had already validated is exactly as it was, and still
    // attributed to Textract.
    assert.equal(outcome.fields.total.value, before.total);
    assert.equal(outcome.fields.total.source, 'TEXTRACT');
    assert.equal(outcome.fields.invoiceNumber.value, before.invoiceNumber);
    assert.equal(line?.quantity.value, before.quantity);
    assert.equal(line?.quantity.source, 'TEXTRACT');
  });

  it('marks the document for review because a value came from the model', async () => {
    stubClient(answerAll('tonnes'));
    const { extraction, ocrText } = invoiceFrom(incompleteResponse());

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-gap',
    });

    assert.equal(outcome.complete, false, 'a fallback-sourced value is never posted unseen');
    assert.equal(outcome.fallback.used, true);
    assert.ok(outcome.issues.some(issue => issue.code === 'FALLBACK_SOURCED'));
    assert.equal(isTrusted(outcome.fields.lines[0]!.unit), false);
  });

  it('drops an answer that does not validate and keeps the field unresolved', async () => {
    // "square feet" is not a unit this system can compare a rate against, so it
    // is refused exactly as it would be from Textract.
    stubClient(answerAll('square feet'));
    const { extraction, ocrText } = invoiceFrom(incompleteResponse());

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-bad',
    });

    assert.equal(outcome.fields.lines[0]?.unit.state, 'MISSING');
    assert.equal(outcome.fields.lines[0]?.unit.value, null);
    assert.equal(outcome.fallback.used, false);
    assert.equal(outcome.fallback.reason, 'REJECTED');
    assert.equal(outcome.complete, false);
    assert.ok(outcome.issues.some(issue => issue.code === 'FALLBACK_REJECTED'));
  });

  it('holds the document when the fallback answers nothing at all', async () => {
    stubClient(() => completion({ 'lines.0.unit': null }));
    const { extraction, ocrText } = invoiceFrom(incompleteResponse());

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-null',
    });

    assert.equal(outcome.fields.lines[0]?.unit.value, null);
    assert.equal(outcome.complete, false);
  });
});

describe('when the fallback is unavailable', () => {
  const gappy = () =>
    invoiceFrom(
      analyzeExpenseResponse({
        summary: [{ type: 'TOTAL', text: '462.50', currency: 'CAD' }],
        lineItems: [{ item: 'Granular A Gravel', quantity: '25', price: '462.50' }],
        blocks: ['Granular A Gravel 25 462.50'],
      })
    );

  it('preserves the deterministic result and asks for review when no key is set', async () => {
    (env as { groqApiKey: string }).groqApiKey = '';
    const create = stubClient(answerAll('tonnes'));
    const { extraction, ocrText } = gappy();

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.9,
      documentType: 'INVOICE',
      jobId: 'job-nokey',
    });

    assert.equal(create.mock.callCount(), 0);
    assert.equal(outcome.fallback.reason, 'NOT_CONFIGURED');
    assert.equal(outcome.complete, false);
    // What Textract did read is still there and still attributed to Textract.
    assert.equal(outcome.fields.total.value, 462.5);
    assert.equal(outcome.fields.total.source, 'TEXTRACT');
    assert.ok(outcome.issues.some(issue => issue.code === 'FALLBACK_UNAVAILABLE'));
  });

  it('preserves the deterministic result when the fallback is switched off', async () => {
    (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = false;
    const create = stubClient(answerAll('tonnes'));
    const { extraction, ocrText } = gappy();

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.9,
      documentType: 'INVOICE',
      jobId: 'job-off',
    });

    assert.equal(create.mock.callCount(), 0);
    assert.equal(outcome.fallback.reason, 'DISABLED');
    assert.equal(outcome.complete, false);
    assert.equal(outcome.fields.total.value, 462.5);
  });

  it('preserves the deterministic result when the service cannot be reached', async () => {
    stubClient(() => {
      throw Object.assign(new Error('down'), { status: 503 });
    });
    const { extraction, ocrText } = gappy();

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.9,
      documentType: 'INVOICE',
      jobId: 'job-down',
    });

    assert.equal(outcome.fallback.reason, 'FAILED');
    assert.equal(outcome.complete, false);
    assert.equal(outcome.fields.total.value, 462.5);
    assert.ok(outcome.issues.some(issue => issue.code === 'FALLBACK_UNAVAILABLE'));
  });
});

describe('review issues', () => {
  it('reports a line that does not add up, after the merge', async () => {
    const response = analyzeExpenseResponse({
      summary: [
        { type: 'VENDOR_NAME', text: 'Northfield Aggregates Ltd' },
        { type: 'INVOICE_RECEIPT_ID', text: 'INV-1' },
        { type: 'INVOICE_RECEIPT_DATE', text: '2026-07-14' },
        { type: 'TOTAL', text: '462.50', currency: 'CAD' },
      ],
      lineItems: [
        { item: 'Granular A Gravel', quantity: '25', unit: 'tonnes', unitPrice: '18.50', price: '999.00' },
      ],
      blocks: ['Granular A Gravel'],
    });
    (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = false;
    const { extraction, ocrText } = invoiceFrom(response);

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-arith',
    });

    assert.ok(outcome.issues.some(issue => issue.code === 'LINE_ARITHMETIC'));
    assert.equal(outcome.complete, false);
  });

  it('reports an invoice with no readable line items', async () => {
    (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = false;
    const { extraction, ocrText } = invoiceFrom(
      analyzeExpenseResponse({
        summary: [{ type: 'TOTAL', text: '462.50', currency: 'CAD' }],
        blocks: ['TOTAL 462.50'],
      })
    );

    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.9,
      documentType: 'INVOICE',
      jobId: 'job-nolines',
    });

    assert.ok(outcome.issues.some(issue => issue.code === 'NO_LINE_ITEMS'));
  });

  it('summarises reasons for the review desk without repeating them', () => {
    const reasons = summariseReviewReasons([
      { field: 'total', code: 'MISSING_FIELD', message: 'Not found' },
      { field: 'total', code: 'MISSING_FIELD', message: 'Not found' },
      { field: 'lines.0.unit', code: 'MISSING_FIELD', message: 'No unit of measure on this line' },
    ]);
    assert.deepEqual(reasons, [
      'total: Not found',
      'lines.0.unit: No unit of measure on this line',
    ]);
  });
});

describe('stored provenance', () => {
  it('records where each field came from, and carries no provider payload', async () => {
    const { extraction, ocrText } = invoiceFrom(cleanInvoiceResponse());
    const outcome = await finaliseInvoiceExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.99,
      documentType: 'INVOICE',
      jobId: 'job-prov',
    });

    const provenance = buildInvoiceProvenance(outcome);

    assert.equal(provenance.fields['total']?.source, 'TEXTRACT');
    assert.equal(provenance.fields['total']?.state, 'VALID');
    assert.equal(provenance.fields['lines.0.unit']?.value, 'tonnes');
    assert.equal(provenance.complete, true);
    assert.equal(provenance.fallback.used, false);

    // The provenance record is not a second copy of the document.
    const serialised = JSON.stringify(provenance);
    assert.ok(!serialised.includes('ExpenseDocuments'), 'no Textract payload');
    assert.ok(!serialised.includes('742 Quarry Line'), 'no OCR text');
  });
});

describe('tickets', () => {
  it('completes a clean ticket without calling the fallback', async () => {
    const create = stubClient(answerAll('x'));
    const extraction = extractTicketFromText({ ocrText: cleanTicketText(), now: NOW });

    const outcome = await finaliseTicketExtraction({
      extraction,
      ocrText: cleanTicketText(),
      ocrConfidence: 0.97,
      documentType: 'TICKET',
      jobId: 'ticket-clean',
    });

    assert.equal(create.mock.callCount(), 0);
    assert.equal(outcome.complete, true);
  });

  it('asks about only the unresolved ticket fields', async () => {
    const create = stubClient(answerAll('447201'));
    const ocrText = ['Northfield Aggregates Ltd', 'Ticket No: 550412', 'Date: 2026-07-14', 'Net Weight 24.50 tonnes'].join('\n');
    const extraction = extractTicketFromText({ ocrText, now: NOW });

    await finaliseTicketExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.95,
      documentType: 'TICKET',
      jobId: 'ticket-gap',
    });

    const requested: string[] = (create.mock.calls[0]?.arguments[0] as any).response_format.json_schema
      .schema.required;
    assert.ok(requested.includes('poNumber'));
    assert.ok(!requested.includes('quantity'), 'net weight was read confidently');
    assert.ok(!requested.includes('ticketNumber'));
  });

  it('does not ask about an absent optional material', async () => {
    const create = stubClient(answerAll('should not be reached'));
    const ocrText = cleanTicketText()
      .split('\n')
      .filter(line => !line.startsWith('Material:'))
      .join('\n');
    const extraction = extractTicketFromText({ ocrText, now: NOW });

    const outcome = await finaliseTicketExtraction({
      extraction,
      ocrText,
      ocrConfidence: 0.97,
      documentType: 'TICKET',
      jobId: 'ticket-no-material',
    });

    assert.equal(extraction.material.state, 'MISSING');
    assert.equal(create.mock.callCount(), 0);
    assert.equal(outcome.complete, true);
  });
});
