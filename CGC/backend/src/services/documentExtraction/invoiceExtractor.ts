/**
 * Deterministic invoice extraction from AWS Textract AnalyzeExpense.
 *
 * AnalyzeExpense already returns the invoice as fields and line items, each with
 * its own confidence. The previous pipeline threw all of that away — it flattened
 * the response back down to raw text and asked a language model to find the
 * numbers again. That discarded the one thing Textract gives that a model cannot:
 * a per-field score tied to a specific region of the page.
 *
 * So the structured response is read first, and the flattened text is used only
 * to fill the gaps Textract left.
 */

import {
  fromTextractConfidence,
  invalid,
  missing,
  valid,
  type ExtractedField,
  type InvoiceExtraction,
  type InvoiceLineExtraction,
} from './types.js';
import {
  validateCadAmount,
  validateDate,
  validatePoNumber,
  validateQuantity,
  validateRate,
  validateText,
  validateUnit,
} from './validation.js';

/**
 * The client's own trading names.
 *
 * These appear on every supplier invoice as the *bill to* party. Textract has no
 * way to know which side of the invoice we are on, and it periodically reports
 * the receiver as VENDOR_NAME — which used to attach a supplier's charges to the
 * client itself. Any vendor name matching one of these is refused.
 */
const OWN_COMPANY_PATTERNS = [
  /cambridge\s+garden\s+cent(re|er)/i,
  /\bcgc\b/i,
];

function isOwnCompany(name: string): boolean {
  return OWN_COMPANY_PATTERNS.some(pattern => pattern.test(name));
}

// Minimal structural views of the AnalyzeExpense response. The AWS SDK types are
// deeply optional, and only these paths are read.
interface TextractDetection {
  Text?: string | undefined;
  Confidence?: number | undefined;
}

interface TextractExpenseField {
  Type?: TextractDetection | undefined;
  LabelDetection?: TextractDetection | undefined;
  ValueDetection?: TextractDetection | undefined;
  Currency?: { Code?: string | undefined; Confidence?: number | undefined } | undefined;
}

interface TextractLineItem {
  LineItemExpenseFields?: TextractExpenseField[] | undefined;
}

interface TextractLineItemGroup {
  LineItems?: TextractLineItem[] | undefined;
}

interface TextractExpenseDocument {
  SummaryFields?: TextractExpenseField[] | undefined;
  LineItemGroups?: TextractLineItemGroup[] | undefined;
  Blocks?:
    | Array<{ BlockType?: string | undefined; Text?: string | undefined; Confidence?: number | undefined }>
    | undefined;
}

export interface AnalyzeExpenseLike {
  ExpenseDocuments?: TextractExpenseDocument[] | undefined;
}

/** The LINE blocks joined in reading order — the OCR text, and nothing else. */
export function getOcrTextFromExpense(response: AnalyzeExpenseLike): string {
  const lines: string[] = [];
  for (const doc of response.ExpenseDocuments ?? []) {
    for (const block of doc.Blocks ?? []) {
      if (block.BlockType === 'LINE' && block.Text) lines.push(block.Text);
    }
  }
  return lines.join('\n');
}

/** Mean confidence across the LINE blocks, 0..1. */
export function getOcrConfidenceFromExpense(response: AnalyzeExpenseLike): number {
  const scores: number[] = [];
  for (const doc of response.ExpenseDocuments ?? []) {
    for (const block of doc.Blocks ?? []) {
      if (block.BlockType === 'LINE' && typeof block.Confidence === 'number') {
        scores.push(block.Confidence);
      }
    }
  }
  if (scores.length === 0) return 0;
  return fromTextractConfidence(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function summaryFields(response: AnalyzeExpenseLike): TextractExpenseField[] {
  return (response.ExpenseDocuments ?? []).flatMap(doc => doc.SummaryFields ?? []);
}

/** All summary fields Textract labelled with this type, most confident first. */
function findSummary(
  response: AnalyzeExpenseLike,
  type: string
): Array<{ text: string; confidence: number; currency: string | null }> {
  return summaryFields(response)
    .filter(field => field.Type?.Text === type)
    .map(field => ({
      text: (field.ValueDetection?.Text ?? '').trim(),
      // The read is only as good as the weaker of "this is a total" and "this
      // total says 412.50", so the two scores are combined multiplicatively.
      confidence:
        fromTextractConfidence(field.ValueDetection?.Confidence) *
        fromTextractConfidence(field.Type?.Confidence),
      currency: field.Currency?.Code ?? null,
    }))
    .filter(entry => entry.text.length > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

function lineItemField(item: TextractLineItem, type: string): { text: string; confidence: number } | null {
  const match = (item.LineItemExpenseFields ?? []).find(field => field.Type?.Text === type);
  if (!match) return null;
  const text = (match.ValueDetection?.Text ?? '').trim();
  if (!text) return null;
  return {
    text,
    confidence:
      fromTextractConfidence(match.ValueDetection?.Confidence) *
      fromTextractConfidence(match.Type?.Confidence),
  };
}

/** A line-item value whose printed column label identifies it. */
function labelledLineItemField(
  item: TextractLineItem,
  label: RegExp
): { text: string; confidence: number } | null {
  const match = (item.LineItemExpenseFields ?? []).find(field => {
    const printedLabel = field.LabelDetection?.Text?.trim() ?? '';
    return printedLabel.length > 0 && label.test(printedLabel);
  });
  if (!match) return null;
  const text = (match.ValueDetection?.Text ?? '').trim();
  if (!text) return null;
  return {
    text,
    confidence:
      fromTextractConfidence(match.ValueDetection?.Confidence) *
      fromTextractConfidence(match.LabelDetection?.Confidence),
  };
}

// ---------------------------------------------------------------------------
// Deterministic gap-filling from the OCR text
// ---------------------------------------------------------------------------

/**
 * A six-digit purchase order announced by a label.
 *
 * Anchored to an explicit PO label rather than scanning for any six-digit run:
 * invoice numbers, postal-adjacent figures and phone fragments are all six
 * digits often enough that an unanchored search attaches the wrong order.
 */
const PO_LABEL_PATTERN =
  /\b(?:p\.?\s*o\.?|purchase\s+order|customer\s+order|order)\s*(?:number|no\.?|num|#)?\s*[:#-]?\s*(\d{6})\b/i;

export function findPoNumberInText(text: string): string | null {
  const match = text.match(PO_LABEL_PATTERN);
  return match?.[1] ?? null;
}

/**
 * A unit of measure sitting next to a quantity, e.g. "24.5 tonnes".
 *
 * Only returns something when the number in the text matches the quantity we
 * already read. Picking up "per tonne" from a footer would attach a unit that
 * belongs to a different line.
 */
export function findUnitNearQuantity(text: string, quantity: number): string | null {
  const pattern = /(\d[\d,]*\.?\d*)\s*([A-Za-z][A-Za-z.]{0,12})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const numeric = Number((match[1] as string).replace(/,/g, ''));
    if (!Number.isFinite(numeric)) continue;
    if (Math.abs(numeric - quantity) > 1e-6) continue;
    const candidate = (match[2] as string).replace(/\.$/, '');
    if (validateUnit(candidate).ok) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

function textField(
  candidates: Array<{ text: string; confidence: number }>,
  label: string,
  reject?: (value: string) => string | null
): ExtractedField<string> {
  if (candidates.length === 0) return missing(`No ${label.toLowerCase()} on the document`);

  let lastReason = `No ${label.toLowerCase()} on the document`;
  for (const candidate of candidates) {
    const checked = validateText(candidate.text, label);
    if (!checked.ok) {
      lastReason = checked.reason as string;
      continue;
    }
    const rejection = reject?.(checked.value as string);
    if (rejection) {
      lastReason = rejection;
      continue;
    }
    return valid(checked.value as string, 'TEXTRACT', candidate.confidence * checked.confidenceFactor);
  }
  return invalid('TEXTRACT', lastReason);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface InvoiceExtractionInput {
  response: AnalyzeExpenseLike;
  ocrText: string;
  now?: Date;
}

/**
 * Build a typed invoice from an AnalyzeExpense response.
 *
 * Nothing here calls out to a model, and nothing here invents a value. Every
 * field ends up VALID with a provenance, or MISSING/INVALID with a reason.
 */
export function extractInvoiceFromExpense({
  response,
  ocrText,
  now = new Date(),
}: InvoiceExtractionInput): InvoiceExtraction {
  const supplierName = textField(
    findSummary(response, 'VENDOR_NAME'),
    'Supplier name',
    value =>
      isOwnCompany(value)
        ? 'Textract read our own company as the vendor; the real supplier was not identified'
        : null
  );

  const invoiceNumber = textField(findSummary(response, 'INVOICE_RECEIPT_ID'), 'Invoice number');

  const invoiceDate = buildDate(findSummary(response, 'INVOICE_RECEIPT_DATE'), now);
  const total = buildTotal(findSummary(response, 'TOTAL'));
  const poNumber = buildPoNumber(findSummary(response, 'PO_NUMBER'), ocrText);

  const lines = buildLines(response, ocrText, poNumber.value);

  return { supplierName, invoiceNumber, invoiceDate, poNumber, total, lines };
}

function buildDate(
  candidates: Array<{ text: string; confidence: number }>,
  now: Date
): ExtractedField<string> {
  if (candidates.length === 0) return missing('No invoice date on the document');
  let lastReason = 'No invoice date on the document';
  for (const candidate of candidates) {
    const checked = validateDate(candidate.text, now);
    if (checked.ok) {
      return valid(checked.value as string, 'TEXTRACT', candidate.confidence * checked.confidenceFactor);
    }
    lastReason = checked.reason as string;
  }
  return invalid('TEXTRACT', lastReason);
}

function buildTotal(
  candidates: Array<{ text: string; confidence: number; currency: string | null }>
): ExtractedField<number> {
  if (candidates.length === 0) return missing('No invoice total on the document');

  let lastReason = 'No invoice total on the document';
  for (const candidate of candidates) {
    // Every supplier here bills in Canadian dollars. A total Textract has
    // labelled USD is either a different document or a misread currency symbol,
    // and posting it at face value would understate the payable.
    if (candidate.currency && candidate.currency.toUpperCase() !== 'CAD') {
      lastReason = `Invoice total is in ${candidate.currency}, not CAD`;
      continue;
    }
    const checked = validateCadAmount(candidate.text, 'Invoice total');
    if (checked.ok) {
      return valid(checked.value as number, 'TEXTRACT', candidate.confidence * checked.confidenceFactor);
    }
    lastReason = checked.reason as string;
  }
  return invalid('TEXTRACT', lastReason);
}

function buildPoNumber(
  candidates: Array<{ text: string; confidence: number }>,
  ocrText: string
): ExtractedField<string> {
  for (const candidate of candidates) {
    const checked = validatePoNumber(candidate.text);
    if (checked.ok) {
      return valid(checked.value as string, 'TEXTRACT', candidate.confidence * checked.confidenceFactor);
    }
  }

  // Textract does not label PO_NUMBER on many aggregate invoices, so fall back
  // to the labelled search over the OCR text. Still deterministic, still
  // anchored to a label — just scored lower than a field Textract typed itself.
  const fromText = findPoNumberInText(ocrText);
  if (fromText) return valid(fromText, 'DETERMINISTIC', 0.85);

  if (candidates.length > 0) {
    return invalid('TEXTRACT', 'The PO number on the document is not six digits');
  }
  return missing('No six-digit PO number on the document');
}

function buildLines(
  response: AnalyzeExpenseLike,
  ocrText: string,
  headerPo: string | null
): InvoiceLineExtraction[] {
  const items = (response.ExpenseDocuments ?? [])
    .flatMap(doc => doc.LineItemGroups ?? [])
    .flatMap(group => group.LineItems ?? []);

  return items.map(item => buildLine(item, ocrText, headerPo)).filter(line => !isEmptyLine(line));
}

/**
 * Textract emits a row for page furniture — a subtotal band, a repeated header —
 * often enough that keeping them would add phantom line items to every invoice.
 * A row with no description and no numbers at all is one of those.
 */
function isEmptyLine(line: InvoiceLineExtraction): boolean {
  return (
    line.description.state !== 'VALID' &&
    line.quantity.state !== 'VALID' &&
    line.unitRate.state !== 'VALID' &&
    line.lineTotal.state !== 'VALID'
  );
}

function buildLine(
  item: TextractLineItem,
  ocrText: string,
  headerPo: string | null
): InvoiceLineExtraction {
  const rowText = lineItemField(item, 'EXPENSE_ROW')?.text ?? '';

  const description = fieldFrom(lineItemField(item, 'ITEM'), raw => validateText(raw, 'Description'), 'Description');
  const quantity = fieldFrom(lineItemField(item, 'QUANTITY'), validateQuantity, 'Quantity');
  const unitRate = fieldFrom(lineItemField(item, 'UNIT_PRICE'), validateRate, 'Unit rate');
  const lineTotal = fieldFrom(
    lineItemField(item, 'PRICE'),
    raw => validateCadAmount(raw, 'Line total'),
    'Line total'
  );

  return {
    description,
    quantity,
    unit: buildLineUnit(item, rowText, quantity.value),
    unitRate,
    lineTotal,
    poNumber: buildLinePo(item, rowText, headerPo),
  };
}

function fieldFrom<T>(
  candidate: { text: string; confidence: number } | null,
  validate: (raw: string) => { ok: boolean; value: T | null; reason: string | null; confidenceFactor: number },
  label: string
): ExtractedField<T> {
  if (!candidate) return missing(`No ${label.toLowerCase()} on this line`);
  const checked = validate(candidate.text);
  if (!checked.ok) return invalid('TEXTRACT', checked.reason as string);
  return valid(checked.value as T, 'TEXTRACT', candidate.confidence * checked.confidenceFactor);
}

/**
 * The unit for a line, or nothing.
 *
 * There is no default. A line whose unit cannot be read stays unresolved and
 * goes to a person — the old "ea" default made every unreadable tonnage line
 * look like a per-item charge and quietly disabled the rate comparison.
 */
function buildLineUnit(
  item: TextractLineItem,
  rowText: string,
  quantity: number | null
): ExtractedField<string> {
  // AnalyzeExpense has no normalized UNIT type. Explicit UOM columns arrive as
  // OTHER with LabelDetection; otherwise the unit is read beside the already
  // validated quantity in EXPENSE_ROW.
  const typed = labelledLineItemField(item, /^(?:unit|uom|unit\s+of\s+measure)$/i);
  if (typed) {
    const checked = validateUnit(typed.text);
    if (checked.ok) return valid(checked.value as string, 'TEXTRACT', typed.confidence * checked.confidenceFactor);
  }

  if (quantity !== null && rowText) {
    const nearby = findUnitNearQuantity(rowText, quantity);
    if (nearby) return valid(nearby, 'DETERMINISTIC', 0.85);
  }

  if (typed) return invalid('TEXTRACT', `Unit "${typed.text}" is not a recognised unit of measure`);
  return missing('No unit of measure on this line');
}

/**
 * A line's own PO, falling back to the invoice header PO.
 *
 * The header PO is inherited rather than re-derived: on a single-PO invoice
 * every line belongs to that order, and treating the lines as unattributed made
 * every one of them raise NO_ORDER.
 */
function buildLinePo(
  item: TextractLineItem,
  rowText: string,
  headerPo: string | null
): ExtractedField<string> {
  const typed = labelledLineItemField(
    item,
    /^(?:p\.?\s*o\.?|purchase\s+order)(?:\s*(?:number|no\.?|#))?$/i
  );
  if (typed) {
    const checked = validatePoNumber(typed.text);
    if (checked.ok) return valid(checked.value as string, 'TEXTRACT', typed.confidence);
  }

  const inRow = rowText ? findPoNumberInText(rowText) : null;
  if (inRow) return valid(inRow, 'DETERMINISTIC', 0.8);

  if (headerPo) return valid(headerPo, 'DETERMINISTIC', 0.8);
  return missing('No PO number on this line or in the invoice header');
}
