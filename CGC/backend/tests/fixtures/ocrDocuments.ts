/**
 * Synthetic OCR fixtures.
 *
 * Every company name, address, invoice number and figure here is invented. No
 * client document, scan, or production export is committed to this repository —
 * these are hand-built to exercise the shapes Textract produces, not copies of
 * anything real.
 */

import type { AnalyzeExpenseLike } from '../../src/services/documentExtraction/invoiceExtractor.js';

export interface SummaryFieldSpec {
  type: string;
  text: string;
  /** Percentages, the way Textract reports them. */
  confidence?: number;
  typeConfidence?: number;
  currency?: string;
}

export interface LineItemSpec {
  item?: string;
  quantity?: string;
  unitPrice?: string;
  price?: string;
  productCode?: string;
  expenseRow?: string;
  confidence?: number;
}

function detection(text: string, confidence: number) {
  return { Text: text, Confidence: confidence };
}

function expenseField(type: string, text: string, valueConfidence: number, typeConfidence: number, currency?: string) {
  return {
    Type: detection(type, typeConfidence),
    ValueDetection: detection(text, valueConfidence),
    ...(currency ? { Currency: { Code: currency, Confidence: 99 } } : {}),
  };
}

/**
 * Build an AnalyzeExpense response.
 *
 * `blocks` are the LINE blocks Textract also returns; they are what the OCR text
 * and the deterministic gap-filling are built from, so tests that exercise the
 * text path have to supply them.
 */
export function analyzeExpenseResponse(options: {
  summary?: SummaryFieldSpec[];
  lineItems?: LineItemSpec[];
  blocks?: string[];
  blockConfidence?: number;
}): AnalyzeExpenseLike {
  const {
    summary = [],
    lineItems = [],
    blocks = [],
    blockConfidence = 99,
  } = options;

  return {
    ExpenseDocuments: [
      {
        SummaryFields: summary.map(field =>
          expenseField(
            field.type,
            field.text,
            field.confidence ?? 99,
            field.typeConfidence ?? 99,
            field.currency
          )
        ),
        LineItemGroups: [
          {
            LineItems: lineItems.map(line => {
              const fields = [];
              const confidence = line.confidence ?? 99;
              if (line.item !== undefined) fields.push(expenseField('ITEM', line.item, confidence, 99));
              if (line.quantity !== undefined) fields.push(expenseField('QUANTITY', line.quantity, confidence, 99));
              if (line.unitPrice !== undefined) fields.push(expenseField('UNIT_PRICE', line.unitPrice, confidence, 99));
              if (line.price !== undefined) fields.push(expenseField('PRICE', line.price, confidence, 99));
              if (line.productCode !== undefined) {
                fields.push(expenseField('PRODUCT_CODE', line.productCode, confidence, 99));
              }
              if (line.expenseRow !== undefined) {
                fields.push(expenseField('EXPENSE_ROW', line.expenseRow, confidence, 99));
              }
              return { LineItemExpenseFields: fields };
            }),
          },
        ],
        Blocks: blocks.map(text => ({ BlockType: 'LINE', Text: text, Confidence: blockConfidence })),
      },
    ],
  };
}

/** A clean, entirely readable two-line invoice. */
export function cleanInvoiceResponse(): AnalyzeExpenseLike {
  return analyzeExpenseResponse({
    summary: [
      { type: 'VENDOR_NAME', text: 'Northfield Aggregates Ltd' },
      { type: 'INVOICE_RECEIPT_ID', text: 'INV-88213' },
      { type: 'INVOICE_RECEIPT_DATE', text: '2026-07-14' },
      { type: 'PO_NUMBER', text: '447201' },
      { type: 'TOTAL', text: '$1,412.50', currency: 'CAD' },
    ],
    lineItems: [
      {
        item: 'Granular A Gravel',
        quantity: '25',
        unitPrice: '18.50',
        price: '462.50',
        expenseRow: '1 Granular A Gravel 25 tonnes 18.50 462.50',
      },
      {
        item: 'Screened Sand',
        quantity: '38',
        unitPrice: '25.00',
        price: '950.00',
        expenseRow: '2 Screened Sand 38 tonnes 25.00 950.00',
      },
    ],
    blocks: [
      'Northfield Aggregates Ltd',
      '742 Quarry Line, Cambridge ON',
      'INVOICE INV-88213',
      'Date: 2026-07-14',
      'P.O. Number: 447201',
      'Granular A Gravel 25 tonnes 18.50 462.50',
      'Screened Sand 38 tonnes 25.00 950.00',
      'Subtotal 1,412.50',
      'TOTAL $1,412.50',
    ],
  });
}

/** A clean, entirely readable scale ticket. */
export function cleanTicketText(): string {
  return [
    'Northfield Aggregates Ltd',
    '742 Quarry Line, Cambridge ON',
    'DELIVERY TICKET',
    'Ticket No: 550412',
    'Date: 2026-07-14',
    'P.O. Number: 447201',
    'Sold To: Cambridge Garden Centre',
    'Material: Granular A Gravel',
    'Gross Weight 41.20 tonnes',
    'Tare Weight 16.70 tonnes',
    'Net Weight 24.50 tonnes',
    'Driver: unit 12',
  ].join('\n');
}
