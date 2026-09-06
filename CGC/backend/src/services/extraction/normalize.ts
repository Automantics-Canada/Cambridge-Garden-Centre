import { normaliseUnit } from '../../lib/units.js';
import {
  READABILITY_CONFIDENCE,
  type InvoiceExtraction,
  type Readability,
  type TicketExtraction,
} from './schemas.js';

/**
 * Tidying that belongs in code, not in a prompt.
 *
 * Everything here is a rule with one right answer — trimming whitespace,
 * turning `"2026-08-13"` into a Date, deciding whether six digits are six
 * digits. Asking a model to apply rules like these is how they end up applied
 * *sometimes*: the previous pipeline put "PO numbers are exactly 6 digits" in
 * the prompt AND re-checked it in code afterwards, and only the code half was
 * ever reliable.
 *
 * Units are the deliberate exception. They are stored exactly as the supplier
 * printed them and canonicalised only at comparison time by lib/units.ts,
 * which holds `ton` and `tonne` apart on purpose — they differ by about ten
 * percent and both appear on Ontario aggregate paperwork. Rewriting the unit
 * here would throw away the evidence of which one the document actually said.
 */

export interface NormalizedTicket {
  supplierName: string | null;
  ticketDate: Date | null;
  ticketNumber: string | null;
  poNumber: string | null;
  material: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number;
  readability: Readability;
  uncertainFields: string[];
}

export interface NormalizedInvoiceLineItem {
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  poNumber: string | null;
}

export interface NormalizedInvoice {
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  poNumber: string | null;
  totalAmount: number | null;
  lineItems: NormalizedInvoiceLineItem[];
  confidence: number;
  readability: Readability;
  uncertainFields: string[];
}

/** Trims, and treats blank or placeholder text as absent. */
export function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Models occasionally write the absence of a value rather than returning
  // null. Left alone, "N/A" becomes a supplier name and then a supplier record.
  if (/^(n\/?a|none|null|unknown|not\s+(?:shown|found|specified|visible))$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * A PO is six digits. Anything else is kept as read, not discarded.
 *
 * `"PO# 123456"` and `"123-456"` are the same order and are cleaned to
 * `123456`. A value that is not six digits after cleaning is passed through
 * unchanged: it fails the six-digit test downstream so it will not auto-link
 * anything, but a person on the verification desk can still see what was
 * printed. Blanking it would destroy the only clue to the right order.
 */
export function normalizePoNumber(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (text === null) return null;
  const digitsOnly = text.replace(/\D/g, '');
  return digitsOnly.length === 6 ? digitsOnly : text;
}

/**
 * Parses a `YYYY-MM-DD` date at UTC midnight.
 *
 * Built from its parts rather than handed to `new Date(string)`, which accepts
 * a pile of other formats and resolves some of them in local time. These are
 * date-only values on paperwork; anchoring them to UTC keeps a ticket dated the
 * 13th from becoming the 12th for a reader in Ontario.
 */
export function parseDocumentDate(value: string | null | undefined): Date | null {
  const text = cleanText(value);
  if (text === null) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Rejects a real-looking but impossible date such as 2026-02-30, which
  // Date.UTC would roll forward into March.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

/** Rejects NaN and Infinity, which JSON can carry through as numbers. */
export function cleanNumber(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Adds a field name once, preserving the order the model reported them in.
 */
function flag(uncertain: string[], field: string): void {
  if (!uncertain.includes(field)) uncertain.push(field);
}

/**
 * Field names that need a human, whatever the model thought.
 *
 * A unit nobody recognises cannot be compared against an order or a ticket, and
 * a PO that is not six digits will not link. Both are quiet failures otherwise:
 * the document processes "successfully" and simply never matches anything.
 */
function flagUnreadableUnits(unit: string | null, fieldName: string, uncertain: string[]): void {
  if (unit !== null && normaliseUnit(unit) === null) flag(uncertain, fieldName);
}

export function normalizeTicket(raw: TicketExtraction): NormalizedTicket {
  const uncertainFields = [...raw.uncertainFields];

  const poNumber = normalizePoNumber(raw.poNumber);
  if (poNumber !== null && !/^\d{6}$/.test(poNumber)) flag(uncertainFields, 'poNumber');

  const unit = cleanText(raw.unit);
  flagUnreadableUnits(unit, 'unit', uncertainFields);

  return {
    supplierName: cleanText(raw.supplierName),
    ticketDate: parseDocumentDate(raw.date),
    ticketNumber: cleanText(raw.ticketNumber),
    poNumber,
    material: cleanText(raw.material),
    quantity: cleanNumber(raw.quantity),
    unit,
    confidence: READABILITY_CONFIDENCE[raw.readability],
    readability: raw.readability,
    uncertainFields,
  };
}

export function normalizeInvoice(raw: InvoiceExtraction): NormalizedInvoice {
  const uncertainFields = [...raw.uncertainFields];

  const poNumber = normalizePoNumber(raw.poNumber);
  if (poNumber !== null && !/^\d{6}$/.test(poNumber)) flag(uncertainFields, 'poNumber');

  const lineItems = raw.lineItems.map((item, index) => {
    const linePo = normalizePoNumber(item.poNumber);
    if (linePo !== null && !/^\d{6}$/.test(linePo)) {
      flag(uncertainFields, `lineItems[${index}].poNumber`);
    }

    const unit = cleanText(item.unit);
    // A line with no unit cannot be checked against a delivery ticket at all,
    // so it is worth a person's attention rather than a default of "ea" — which
    // is what the pipeline this replaced quietly filled in.
    if (unit === null) flag(uncertainFields, `lineItems[${index}].unit`);
    flagUnreadableUnits(unit, `lineItems[${index}].unit`, uncertainFields);

    return {
      description: cleanText(item.description) ?? 'Unknown Item',
      quantity: cleanNumber(item.quantity),
      unit,
      unitPrice: cleanNumber(item.unitPrice),
      totalPrice: cleanNumber(item.totalPrice),
      poNumber: linePo,
    };
  });

  return {
    supplierName: cleanText(raw.supplierName),
    invoiceNumber: cleanText(raw.invoiceNumber),
    invoiceDate: parseDocumentDate(raw.date),
    poNumber,
    totalAmount: cleanNumber(raw.totalAmount),
    lineItems,
    confidence: READABILITY_CONFIDENCE[raw.readability],
    readability: raw.readability,
    uncertainFields,
  };
}
