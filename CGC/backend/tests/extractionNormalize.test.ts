import './setupEnv.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanNumber,
  cleanText,
  normalizeInvoice,
  normalizePoNumber,
  normalizeTicket,
  parseDocumentDate,
} from '../src/services/extraction/normalize.js';
import type { InvoiceExtraction, TicketExtraction } from '../src/services/extraction/schemas.js';

/**
 * The rules that turn a model's reading into stored fields.
 *
 * These are the half of extraction that must behave identically every time, so
 * they are the half worth testing exhaustively. What the model reads off a
 * photograph is measured separately by scripts/extractionEval.ts, against real
 * documents and their hand-checked values.
 */

function ticket(overrides: Partial<TicketExtraction> = {}): TicketExtraction {
  return {
    supplierName: 'Dufferin Aggregates',
    date: '2026-08-13',
    ticketNumber: 'T-88213',
    poNumber: '123456',
    material: 'A Gravel',
    quantity: 24.6,
    unit: 'tonnes',
    readability: 'clear',
    uncertainFields: [],
    ...overrides,
  };
}

function invoice(overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    supplierName: 'Dufferin Aggregates',
    invoiceNumber: 'INV-5512',
    date: '2026-08-31',
    poNumber: '123456',
    totalAmount: 1840.5,
    lineItems: [
      {
        description: '19mm Clear Stone',
        quantity: 22,
        unit: 'tonnes',
        unitPrice: 78.5,
        totalPrice: 1727,
        poNumber: '123456',
      },
    ],
    readability: 'clear',
    uncertainFields: [],
    ...overrides,
  };
}

describe('cleanText', () => {
  test('trims, and treats blank as absent', () => {
    assert.equal(cleanText('  Dufferin  '), 'Dufferin');
    assert.equal(cleanText('   '), null);
    assert.equal(cleanText(''), null);
    assert.equal(cleanText(null), null);
  });

  test('rejects the ways a model writes "there is nothing here"', () => {
    // Left alone, each of these becomes a supplier name and then a supplier row.
    for (const written of ['N/A', 'n/a', 'None', 'null', 'unknown', 'Not shown', 'not specified']) {
      assert.equal(cleanText(written), null, `expected "${written}" to read as absent`);
    }
  });

  test('keeps a real value that merely contains one of those words', () => {
    assert.equal(cleanText('Unknown Quarry Ltd'), 'Unknown Quarry Ltd');
  });
});

describe('normalizePoNumber', () => {
  test('strips decoration from a six digit PO', () => {
    assert.equal(normalizePoNumber('PO# 123456'), '123456');
    assert.equal(normalizePoNumber('123-456'), '123456');
    assert.equal(normalizePoNumber('  123456 '), '123456');
  });

  test('keeps a value that is not six digits, rather than discarding it', () => {
    // It will not auto-link — the six-digit test downstream sees to that — but
    // blanking it would destroy the only clue to the right order.
    assert.equal(normalizePoNumber('12345'), '12345');
    assert.equal(normalizePoNumber('1234567'), '1234567');
    assert.equal(normalizePoNumber('CGC-99'), 'CGC-99');
  });

  test('absent stays absent', () => {
    assert.equal(normalizePoNumber(null), null);
    assert.equal(normalizePoNumber('  '), null);
  });
});

describe('parseDocumentDate', () => {
  test('reads an ISO date at UTC midnight', () => {
    const parsed = parseDocumentDate('2026-08-13');
    assert.equal(parsed?.toISOString(), '2026-08-13T00:00:00.000Z');
  });

  test('a ticket dated the 13th does not become the 12th', () => {
    // Ontario runs at UTC-4/-5. Local-time parsing put date-only values on the
    // previous day for every reader in the client's own timezone.
    const parsed = parseDocumentDate('2026-08-13');
    assert.equal(parsed?.getUTCDate(), 13);
  });

  test('refuses dates that do not exist', () => {
    // Date.UTC would roll this forward into March and report it as read.
    assert.equal(parseDocumentDate('2026-02-30'), null);
    assert.equal(parseDocumentDate('2026-13-01'), null);
    assert.equal(parseDocumentDate('2026-00-10'), null);
  });

  test('refuses formats other than YYYY-MM-DD', () => {
    assert.equal(parseDocumentDate('13/08/2026'), null);
    assert.equal(parseDocumentDate('Aug 13, 2026'), null);
    assert.equal(parseDocumentDate('2026-8-13'), null);
    assert.equal(parseDocumentDate('not a date'), null);
  });
});

describe('cleanNumber', () => {
  test('passes finite numbers, including zero and negatives', () => {
    assert.equal(cleanNumber(24.6), 24.6);
    assert.equal(cleanNumber(0), 0);
    assert.equal(cleanNumber(-3), -3);
  });

  test('rejects the non-numbers JSON can still carry', () => {
    assert.equal(cleanNumber(NaN), null);
    assert.equal(cleanNumber(Infinity), null);
    assert.equal(cleanNumber(null), null);
  });
});

describe('normalizeTicket', () => {
  test('reads a clean ticket into stored fields', () => {
    const result = normalizeTicket(ticket());
    assert.equal(result.supplierName, 'Dufferin Aggregates');
    assert.equal(result.ticketDate?.toISOString(), '2026-08-13T00:00:00.000Z');
    assert.equal(result.poNumber, '123456');
    assert.equal(result.quantity, 24.6);
    assert.equal(result.unit, 'tonnes');
    assert.equal(result.confidence, 0.95);
    assert.deepEqual(result.uncertainFields, []);
  });

  test('readability becomes the stored confidence', () => {
    assert.equal(normalizeTicket(ticket({ readability: 'clear' })).confidence, 0.95);
    assert.equal(normalizeTicket(ticket({ readability: 'partly_legible' })).confidence, 0.7);
    assert.equal(normalizeTicket(ticket({ readability: 'poor' })).confidence, 0.4);
  });

  test('the unit is stored exactly as printed', () => {
    // lib/units.ts holds `ton` and `tonne` apart on purpose: they differ by
    // about ten percent and both appear on Ontario aggregate paperwork.
    // Canonicalising here would throw away which one the document said.
    assert.equal(normalizeTicket(ticket({ unit: 'tonnes' })).unit, 'tonnes');
    assert.equal(normalizeTicket(ticket({ unit: 'tons' })).unit, 'tons');
  });

  test('a PO that is not six digits is flagged for a person', () => {
    const result = normalizeTicket(ticket({ poNumber: '12345' }));
    assert.equal(result.poNumber, '12345');
    assert.ok(result.uncertainFields.includes('poNumber'));
  });

  test('a unit nobody recognises is flagged', () => {
    // Otherwise it processes "successfully" and simply never matches anything.
    const result = normalizeTicket(ticket({ unit: 'bushels' }));
    assert.ok(result.uncertainFields.includes('unit'));
  });

  test("the model's own doubts are kept, not overwritten", () => {
    const result = normalizeTicket(ticket({ uncertainFields: ['quantity'], poNumber: '99' }));
    assert.ok(result.uncertainFields.includes('quantity'));
    assert.ok(result.uncertainFields.includes('poNumber'));
  });

  test('a field is never flagged twice', () => {
    const result = normalizeTicket(ticket({ uncertainFields: ['poNumber'], poNumber: '99' }));
    assert.equal(result.uncertainFields.filter((f) => f === 'poNumber').length, 1);
  });

  test('an unreadable ticket yields nulls, not guesses', () => {
    const result = normalizeTicket(
      ticket({
        supplierName: null,
        date: null,
        ticketNumber: null,
        poNumber: null,
        material: null,
        quantity: null,
        unit: null,
        readability: 'poor',
        uncertainFields: ['quantity', 'poNumber'],
      })
    );
    assert.equal(result.supplierName, null);
    assert.equal(result.ticketDate, null);
    assert.equal(result.quantity, null);
    assert.equal(result.confidence, 0.4);
    assert.deepEqual(result.uncertainFields, ['quantity', 'poNumber']);
  });
});

describe('normalizeInvoice', () => {
  test('reads a clean invoice and its lines', () => {
    const result = normalizeInvoice(invoice());
    assert.equal(result.invoiceNumber, 'INV-5512');
    assert.equal(result.invoiceDate?.toISOString(), '2026-08-31T00:00:00.000Z');
    assert.equal(result.totalAmount, 1840.5);
    assert.equal(result.lineItems.length, 1);
    assert.equal(result.lineItems[0]?.unit, 'tonnes');
    assert.deepEqual(result.uncertainFields, []);
  });

  test('a line with no unit is flagged, not defaulted to "each"', () => {
    // Defaulting made the line silently comparable against any ticket counted
    // in each, producing a confident verdict from a unit nobody had read.
    const result = normalizeInvoice(
      invoice({ lineItems: [{ ...invoice().lineItems[0]!, unit: null }] })
    );
    assert.equal(result.lineItems[0]?.unit, null);
    assert.ok(result.uncertainFields.includes('lineItems[0].unit'));
  });

  test('flags name the line they belong to', () => {
    const base = invoice().lineItems[0]!;
    const result = normalizeInvoice({
      ...invoice(),
      lineItems: [base, { ...base, poNumber: '77' }, { ...base, unit: null }],
    });
    assert.ok(result.uncertainFields.includes('lineItems[1].poNumber'));
    assert.ok(result.uncertainFields.includes('lineItems[2].unit'));
    assert.ok(!result.uncertainFields.includes('lineItems[0].poNumber'));
  });

  test('a line with no description still has one', () => {
    // `description` is NOT NULL on InvoiceLineItem.
    const result = normalizeInvoice({
      ...invoice(),
      lineItems: [{ ...invoice().lineItems[0]!, description: '   ' }],
    });
    assert.equal(result.lineItems[0]?.description, 'Unknown Item');
  });

  test('an invoice with no readable lines returns an empty list', () => {
    const result = normalizeInvoice(invoice({ lineItems: [], readability: 'poor' }));
    assert.deepEqual(result.lineItems, []);
    assert.equal(result.confidence, 0.4);
  });

  test('line amounts that could not be read stay null rather than zero', () => {
    // Zero is a price. Null is the absence of one, and the difference decides
    // whether a line can be checked at all.
    const result = normalizeInvoice({
      ...invoice(),
      lineItems: [
        { ...invoice().lineItems[0]!, quantity: null, unitPrice: null, totalPrice: null },
      ],
    });
    assert.equal(result.lineItems[0]?.quantity, null);
    assert.equal(result.lineItems[0]?.unitPrice, null);
    assert.equal(result.lineItems[0]?.totalPrice, null);
  });
});
