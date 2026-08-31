/**
 * Deterministic extraction and validation.
 *
 * These are the tests that stop the old failure modes coming back: a missing
 * unit silently becoming "ea", an unreadable price becoming zero, a six-digit
 * PO being confused with an invoice number, and an ambiguous date being resolved
 * confidently in whichever direction happened to be wrong.
 *
 * No network, no database, no model.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractInvoiceFromExpense,
  getOcrTextFromExpense,
  getOcrConfidenceFromExpense,
  findPoNumberInText,
} from '../src/services/documentExtraction/invoiceExtractor.js';
import { extractTicketFromText } from '../src/services/documentExtraction/ticketExtractor.js';
import {
  checkLineArithmetic,
  checkTotalPlausibility,
  parseNumeric,
  validateCadAmount,
  validateDate,
  validatePoNumber,
  validateQuantity,
  validateUnit,
} from '../src/services/documentExtraction/validation.js';
import { isTrusted } from '../src/services/documentExtraction/types.js';
import {
  analyzeExpenseResponse,
  cleanInvoiceResponse,
  cleanTicketText,
} from './fixtures/ocrDocuments.js';

const NOW = new Date('2026-07-20T00:00:00Z');

describe('validation: numbers and money', () => {
  it('reads the number formats documents actually use', () => {
    assert.equal(parseNumeric('$1,412.50'), 1412.5);
    assert.equal(parseNumeric('  18.50 '), 18.5);
    assert.equal(parseNumeric('(240.00)'), -240);
    assert.equal(parseNumeric('1 234'), 1234);
  });

  it('refuses text that is not a single number rather than coercing it', () => {
    // `Number('') || 0` used to turn each of these into a free delivery.
    assert.equal(parseNumeric(''), null);
    assert.equal(parseNumeric('n/a'), null);
    assert.equal(parseNumeric('12.5.0'), null);
    assert.equal(parseNumeric(null), null);
    assert.equal(parseNumeric(undefined), null);
  });

  it('rejects a quantity of zero but allows a rate of zero', () => {
    assert.equal(validateQuantity('0').ok, false);
    assert.equal(validateQuantity('24.5').value, 24.5);
    assert.equal(validateCadAmount('0.00', 'Line total').ok, true);
  });

  it('rejects amounts that are implausible or over-precise', () => {
    assert.equal(validateCadAmount('9999999.00').ok, false);
    assert.equal(validateCadAmount('412.5039').ok, false);
    assert.equal(validateCadAmount('-5.00').ok, false);
    assert.equal(validateCadAmount('412.50').value, 412.5);
  });
});

describe('validation: PO numbers', () => {
  it('accepts exactly six digits, however they are punctuated', () => {
    assert.equal(validatePoNumber('447201').value, '447201');
    assert.equal(validatePoNumber('PO# 447201').value, '447201');
    assert.equal(validatePoNumber(' 447-201 ').value, '447201');
  });

  it('refuses anything that is not six digits instead of padding it', () => {
    assert.equal(validatePoNumber('44720').ok, false);
    assert.equal(validatePoNumber('4472011').ok, false);
    assert.equal(validatePoNumber('INV-88213').ok, false);
    assert.equal(validatePoNumber(null).ok, false);
  });
});

describe('validation: units', () => {
  it('accepts the synonyms that appear on Ontario aggregate paperwork', () => {
    for (const unit of ['tonnes', 'tonne', 'MT', 'tons', 'ton', 'cy', 'cubic yards', 'lbs', 'ea']) {
      assert.equal(validateUnit(unit).ok, true, `${unit} should be recognised`);
    }
  });

  it('leaves an unrecognised unit unresolved rather than defaulting it', () => {
    assert.equal(validateUnit('sqft').ok, false);
    assert.equal(validateUnit('').ok, false);
    assert.equal(validateUnit(null).ok, false);
    // The important half: nothing anywhere turns these into "ea".
    assert.equal(validateUnit(null).value, null);
  });
});

describe('validation: dates', () => {
  it('reads ISO and textual months confidently', () => {
    assert.equal(validateDate('2026-07-14', NOW).value, '2026-07-14');
    assert.equal(validateDate('14 Jul 2026', NOW).value, '2026-07-14');
    assert.equal(validateDate('July 14, 2026', NOW).value, '2026-07-14');
    assert.equal(validateDate('2026-07-14', NOW).confidenceFactor, 1);
  });

  it('uses the unambiguous reading when only one is a real month', () => {
    // 14 cannot be a month, so this is day-first regardless of convention.
    const result = validateDate('14/07/2026', NOW);
    assert.equal(result.value, '2026-07-14');
    assert.equal(result.confidenceFactor, 1);
  });

  it('flags a genuinely ambiguous numeric date instead of guessing silently', () => {
    // 03/04/2026 is March 4th or April 3rd. Month-first is used, but the
    // confidence drops so the document reaches a person.
    const result = validateDate('03/04/2026', NOW);
    assert.equal(result.ok, true);
    assert.equal(result.value, '2026-03-04');
    assert.ok(result.confidenceFactor < 1, 'ambiguous dates must not be fully confident');
  });

  it('rejects impossible and out-of-range dates', () => {
    assert.equal(validateDate('2026-02-31', NOW).ok, false);
    assert.equal(validateDate('2031-01-01', NOW).ok, false, 'too far in the future');
    assert.equal(validateDate('1998-01-01', NOW).ok, false, 'too far in the past');
    assert.equal(validateDate('not a date', NOW).ok, false);
  });
});

describe('validation: arithmetic', () => {
  it('confirms a line that adds up and reports one that does not', () => {
    assert.equal(checkLineArithmetic(25, 18.5, 462.5).agrees, true);
    assert.equal(checkLineArithmetic(25, 18.5, 999).agrees, false);
  });

  it('does not check arithmetic when a component is missing', () => {
    assert.equal(checkLineArithmetic(25, null, 462.5).checked, false);
  });

  it('allows the invoice total to carry HST above the line sum', () => {
    assert.equal(checkTotalPlausibility([462.5, 950], 1412.5).agrees, true);
    assert.equal(checkTotalPlausibility([462.5, 950], 1596.13).agrees, true, 'lines + 13%');
    assert.equal(checkTotalPlausibility([462.5, 950], 4000).agrees, false);
    assert.equal(checkTotalPlausibility([462.5, 950], 100).agrees, false);
  });
});

describe('invoice extraction from AnalyzeExpense', () => {
  it('turns a clean response into a fully trusted typed result', () => {
    const response = cleanInvoiceResponse();
    const ocrText = getOcrTextFromExpense(response);
    const extraction = extractInvoiceFromExpense({ response, ocrText, now: NOW });

    assert.equal(extraction.supplierName.value, 'Northfield Aggregates Ltd');
    assert.equal(extraction.supplierName.source, 'TEXTRACT');
    assert.equal(extraction.invoiceNumber.value, 'INV-88213');
    assert.equal(extraction.invoiceDate.value, '2026-07-14');
    assert.equal(extraction.poNumber.value, '447201');
    assert.equal(extraction.total.value, 1412.5);
    assert.equal(extraction.lines.length, 2);

    for (const field of [
      extraction.supplierName,
      extraction.invoiceNumber,
      extraction.invoiceDate,
      extraction.poNumber,
      extraction.total,
    ]) {
      assert.ok(isTrusted(field), 'a clean read should be trusted');
    }

    const [first, second] = extraction.lines;
    assert.equal(first?.description.value, 'Granular A Gravel');
    assert.equal(first?.quantity.value, 25);
    assert.equal(first?.unit.value, 'tonnes');
    assert.equal(first?.unitRate.value, 18.5);
    assert.equal(first?.lineTotal.value, 462.5);
    // The header PO is inherited by lines that do not carry their own.
    assert.equal(first?.poNumber.value, '447201');
    assert.equal(second?.lineTotal.value, 950);
  });

  it('carries the OCR text and mean confidence separately from the fields', () => {
    const response = cleanInvoiceResponse();
    const text = getOcrTextFromExpense(response);
    assert.ok(text.includes('Northfield Aggregates Ltd'));
    assert.ok(text.includes('TOTAL $1,412.50'));
    assert.equal(getOcrConfidenceFromExpense(response), 0.99);
  });

  it('refuses our own company when Textract reports it as the vendor', () => {
    // Textract sometimes labels the bill-to party as VENDOR_NAME. Accepting it
    // attached a supplier's charges to the client itself.
    const response = analyzeExpenseResponse({
      summary: [{ type: 'VENDOR_NAME', text: 'Cambridge Garden Centre' }],
      blocks: ['Cambridge Garden Centre'],
    });
    const extraction = extractInvoiceFromExpense({
      response,
      ocrText: getOcrTextFromExpense(response),
      now: NOW,
    });
    assert.equal(extraction.supplierName.state, 'INVALID');
    assert.equal(extraction.supplierName.value, null);
  });

  it('leaves a line with no readable unit unresolved, never "ea"', () => {
    const response = analyzeExpenseResponse({
      summary: [{ type: 'TOTAL', text: '462.50', currency: 'CAD' }],
      lineItems: [
        {
          item: 'Granular A Gravel',
          quantity: '25',
          unitPrice: '18.50',
          price: '462.50',
          expenseRow: 'Granular A Gravel 25 18.50 462.50',
        },
      ],
      blocks: ['Granular A Gravel 25 18.50 462.50'],
    });
    const extraction = extractInvoiceFromExpense({
      response,
      ocrText: getOcrTextFromExpense(response),
      now: NOW,
    });

    const line = extraction.lines[0];
    assert.equal(line?.unit.state, 'MISSING');
    assert.equal(line?.unit.value, null);
    assert.notEqual(line?.unit.value, 'ea');
  });

  it('recovers a unit written beside the quantity on the row', () => {
    const response = analyzeExpenseResponse({
      lineItems: [
        {
          item: 'Granular A Gravel',
          quantity: '25',
          unitPrice: '18.50',
          price: '462.50',
          expenseRow: 'Granular A Gravel 25 tonnes @ 18.50 462.50',
        },
      ],
      blocks: ['Granular A Gravel 25 tonnes @ 18.50 462.50'],
    });
    const extraction = extractInvoiceFromExpense({
      response,
      ocrText: getOcrTextFromExpense(response),
      now: NOW,
    });

    const line = extraction.lines[0];
    assert.equal(line?.unit.value, 'tonnes');
    assert.equal(line?.unit.source, 'DETERMINISTIC');
    assert.ok(isTrusted(line!.unit), 'an exact quantity-adjacent unit is trusted');
  });

  it('does not reinterpret a six-digit product code as a line PO', () => {
    const response = analyzeExpenseResponse({
      summary: [{ type: 'PO_NUMBER', text: '447201' }],
      lineItems: [
        {
          item: 'Granular A Gravel',
          quantity: '25',
          unitPrice: '18.50',
          price: '462.50',
          productCode: '123456',
          expenseRow: '123456 Granular A Gravel 25 tonnes 18.50 462.50',
        },
      ],
      blocks: ['P.O. Number: 447201', '123456 Granular A Gravel 25 tonnes 18.50 462.50'],
    });
    const extraction = extractInvoiceFromExpense({
      response,
      ocrText: getOcrTextFromExpense(response),
      now: NOW,
    });

    assert.equal(extraction.poNumber.value, '447201');
    assert.equal(extraction.lines[0]?.poNumber.value, '447201');
  });

  it('rejects a total billed in a currency other than CAD', () => {
    const response = analyzeExpenseResponse({
      summary: [{ type: 'TOTAL', text: '1,412.50', currency: 'USD' }],
      blocks: ['TOTAL 1,412.50 USD'],
    });
    const extraction = extractInvoiceFromExpense({
      response,
      ocrText: getOcrTextFromExpense(response),
      now: NOW,
    });
    assert.equal(extraction.total.state, 'INVALID');
    assert.match(extraction.total.reason ?? '', /USD/);
  });

  it('marks a low-confidence Textract read as untrusted without discarding it', () => {
    const response = analyzeExpenseResponse({
      summary: [{ type: 'TOTAL', text: '1412.50', confidence: 55, currency: 'CAD' }],
      blocks: ['TOTAL 1412.50'],
    });
    const extraction = extractInvoiceFromExpense({
      response,
      ocrText: getOcrTextFromExpense(response),
      now: NOW,
    });
    assert.equal(extraction.total.state, 'VALID');
    assert.equal(extraction.total.value, 1412.5);
    assert.equal(isTrusted(extraction.total), false);
  });

  it('produces no fields at all from an empty response', () => {
    const extraction = extractInvoiceFromExpense({
      response: { ExpenseDocuments: [] },
      ocrText: '',
      now: NOW,
    });
    assert.equal(extraction.lines.length, 0);
    assert.equal(extraction.total.state, 'MISSING');
    assert.equal(extraction.supplierName.state, 'MISSING');
  });

  it('drops Textract rows that carry no line data', () => {
    // Page furniture — a repeated header band — arrives as a line item with
    // nothing on it. Keeping them added phantom charges to every invoice.
    const response = analyzeExpenseResponse({
      lineItems: [{ productCode: '447201' }, { item: 'Granular A Gravel', quantity: '25', price: '462.50' }],
      blocks: ['Granular A Gravel 25 462.50'],
    });
    const extraction = extractInvoiceFromExpense({
      response,
      ocrText: getOcrTextFromExpense(response),
      now: NOW,
    });
    assert.equal(extraction.lines.length, 1);
  });

  it('only reads a PO that is announced by a label', () => {
    assert.equal(findPoNumberInText('P.O. Number: 447201'), '447201');
    assert.equal(findPoNumberInText('Purchase Order 447201'), '447201');
    // A bare six-digit run is as likely to be an invoice number or a postal
    // fragment as a PO, so it is not picked up.
    assert.equal(findPoNumberInText('Reference 883921 attached'), null);
  });
});

describe('ticket extraction from OCR text', () => {
  it('reads a clean scale ticket', () => {
    const extraction = extractTicketFromText({ ocrText: cleanTicketText(), now: NOW });

    assert.equal(extraction.supplierName.value, 'Northfield Aggregates Ltd');
    assert.equal(extraction.ticketNumber.value, '550412');
    assert.equal(extraction.ticketDate.value, '2026-07-14');
    assert.equal(extraction.poNumber.value, '447201');
    assert.equal(extraction.material.value, 'Granular A Gravel');
    assert.equal(extraction.unit.value, 'tonnes');
  });

  it('takes net weight, never gross', () => {
    // Billing against gross overstates every load by the mass of the truck.
    const extraction = extractTicketFromText({ ocrText: cleanTicketText(), now: NOW });
    assert.equal(extraction.quantity.value, 24.5);
    assert.notEqual(extraction.quantity.value, 41.2);
  });

  it('takes the value after NET when gross, tare and net share one line', () => {
    const text = [
      'Bayside Quarries Inc',
      'Ticket No: 550412',
      'Date: 2026-07-14',
      'P.O. Number: 447201',
      'Material: Granular A Gravel',
      'Gross 41.20 tonnes Tare 16.70 tonnes Net 24.50 tonnes',
    ].join('\n');
    const extraction = extractTicketFromText({ ocrText: text, now: NOW });
    assert.equal(extraction.quantity.value, 24.5);
    assert.equal(extraction.unit.value, 'tonnes');
    assert.ok(isTrusted(extraction.quantity));
  });

  it('does not read Ticket Date as the ticket number', () => {
    const text = [
      'Bayside Quarries Inc',
      'Ticket Date: 2026-07-14',
      'Ticket No: 550412',
    ].join('\n');
    const extraction = extractTicketFromText({ ocrText: text, now: NOW });
    assert.equal(extraction.ticketNumber.value, '550412');
  });

  it('does not take the next labelled field as a missing PO value', () => {
    const text = [
      'Bayside Quarries Inc',
      'P.O. Number:',
      'Ticket No: 550412',
      'Net Weight: 24.50 tonnes',
    ].join('\n');
    const extraction = extractTicketFromText({ ocrText: text, now: NOW });
    assert.equal(extraction.poNumber.state, 'MISSING');
    assert.equal(extraction.poNumber.value, null);
  });

  it('reads a value printed on the line below its label', () => {
    const text = ['Bayside Quarries Inc', 'Ticket No:', '550412', 'P.O. Number:', '447201'].join('\n');
    const extraction = extractTicketFromText({ ocrText: text, now: NOW });
    assert.equal(extraction.ticketNumber.value, '550412');
    assert.equal(extraction.poNumber.value, '447201');
  });

  it('does not take the bill-to party as the supplier', () => {
    const text = [
      'Cambridge Garden Centre',
      'Bayside Quarries Inc',
      'Ticket No: 550412',
    ].join('\n');
    const extraction = extractTicketFromText({ ocrText: text, now: NOW });
    assert.equal(extraction.supplierName.value, 'Bayside Quarries Inc');
  });

  it('leaves the supplier untrusted when the header is only a bare line', () => {
    // The top line of a ticket is usually the supplier, but not reliably. A line
    // with no company marker is offered at low confidence so it reaches review.
    const text = ['SCALE HOUSE 4', 'Ticket No: 550412'].join('\n');
    const extraction = extractTicketFromText({ ocrText: text, now: NOW });
    assert.equal(extraction.supplierName.state, 'VALID');
    assert.equal(isTrusted(extraction.supplierName), false);
  });

  it('reports every unresolved field on a barely readable ticket', () => {
    const extraction = extractTicketFromText({ ocrText: 'ILLEGIBLE\n####', now: NOW });
    assert.equal(extraction.ticketNumber.state, 'MISSING');
    assert.equal(extraction.poNumber.state, 'MISSING');
    assert.equal(extraction.quantity.state, 'MISSING');
    assert.equal(extraction.unit.state, 'MISSING');
    assert.equal(extraction.unit.value, null);
  });

  it('refuses a PO that is not six digits', () => {
    const extraction = extractTicketFromText({
      ocrText: 'Bayside Quarries Inc\nP.O. Number: 4472\n',
      now: NOW,
    });
    assert.equal(extraction.poNumber.state, 'MISSING');
    assert.equal(extraction.poNumber.value, null);
  });

  it('does not mistake payment terms for a net weight', () => {
    const text = ['Bayside Quarries Inc', 'Terms: Net 30', 'Net Weight 24.50 tonnes'].join('\n');
    const extraction = extractTicketFromText({ ocrText: text, now: NOW });
    assert.equal(extraction.quantity.value, 24.5);
  });
});
