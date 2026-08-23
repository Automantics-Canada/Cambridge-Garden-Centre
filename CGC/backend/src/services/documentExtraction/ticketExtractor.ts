/**
 * Deterministic ticket extraction from Textract DetectDocumentText output.
 *
 * Scale tickets are far more regular than they look. They are printed by a
 * weighbridge, so the same handful of labels — TICKET, P.O., NET, MATERIAL —
 * appear on nearly all of them, in a layout that does not change between loads
 * from the same supplier. That is enough to read them with rules.
 *
 * What the rules will not do is guess. Where a label is absent, the field comes
 * back with a low confidence or not at all, and the fallback model is offered
 * that field and only that field.
 */

import {
  invalid,
  missing,
  valid,
  type ExtractedField,
  type TicketExtraction,
} from './types.js';
import {
  validateDate,
  validatePoNumber,
  validateQuantity,
  validateText,
  validateUnit,
} from './validation.js';

/** See the note in invoiceExtractor: we are the *bill to* party, never the vendor. */
const OWN_COMPANY_PATTERNS = [/cambridge\s+garden\s+cent(re|er)/i, /\bcgc\b/i];

/**
 * Words that mark a line as a company name rather than an address or a label.
 *
 * A ticket's first line is usually the supplier, but not reliably — some
 * weighbridges print a site name or a scale ID above it. A line carrying one of
 * these is a company name with enough certainty to use without review; anything
 * else is offered as a low-confidence guess.
 */
const COMPANY_SUFFIX = /\b(ltd|limited|inc|incorporated|corp|corporation|co|company|aggregates?|quarr(y|ies)|sand|gravel|materials|haulage|transport|redi-?mix|concrete|supply|supplies)\b\.?/i;

const MATERIAL_KEYWORDS = /\b(sand|gravel|stone|aggregate|crush(ed)?|screening|soil|topsoil|mulch|asphalt|limestone|granite|fill|clear|river\s*rock|hpb)\b/i;

/**
 * Read a value printed after a label, on the same line or the next one.
 *
 * Weighbridge printers split label and value across lines often enough that a
 * same-line-only search misses roughly half of them.
 */
function findLabelled(
  lines: string[],
  label: RegExp,
  valuePattern: RegExp
): { text: string; sameLine: boolean } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const labelMatch = line.match(label);
    if (!labelMatch || labelMatch.index === undefined) continue;

    // Only inspect text *after* the matched label. Replacing the label and then
    // scanning the entire line made a compact scale row such as
    // "Gross 41.20 Tare 16.70 Net 24.50" return the earlier gross value.
    const afterLabel = line.slice(labelMatch.index + labelMatch[0].length);
    const inline = afterLabel.match(valuePattern);
    if (inline?.[0]) return { text: (inline[1] ?? inline[0]) as string, sameLine: true };

    const next = lines[index + 1];
    if (next && !looksLikeLabelledLine(next)) {
      const below = next.match(valuePattern);
      if (below?.[0]) return { text: (below[1] ?? below[0]) as string, sameLine: false };
    }
  }
  return null;
}

/** A neighbouring field label is not the current field's value. */
function looksLikeLabelledLine(line: string): boolean {
  return /^[A-Za-z][A-Za-z\s.()/]{1,30}\s*(?::|#|\b(?:no\.?|number)\b)/i.test(line.trim());
}

const NUMBER = /(\d[\d,]*\.?\d*)/;
const ALNUM_ID = /([A-Za-z]{0,4}[-\s]?\d{3,12})/;
const DATE_TEXT =
  /(\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-\s][A-Za-z]{3,9}[-\s,]?\s*\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s*\d{2,4})/;

export interface TicketExtractionInput {
  ocrText: string;
  now?: Date;
}

export function extractTicketFromText({
  ocrText,
  now = new Date(),
}: TicketExtractionInput): TicketExtraction {
  const lines = ocrText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const quantity = buildQuantity(lines);

  return {
    supplierName: buildSupplierName(lines),
    ticketNumber: buildTicketNumber(lines),
    ticketDate: buildDate(lines, now),
    poNumber: buildPoNumber(lines),
    material: buildMaterial(lines),
    quantity: quantity.field,
    unit: buildUnit(lines, quantity.rawLine, quantity.field.value),
  };
}

function buildSupplierName(lines: string[]): ExtractedField<string> {
  const labelled = findLabelled(
    lines,
    /\b(supplier|vendor|carrier|sold\s*by|shipper)\b\s*[:#-]?/i,
    /(.+)/
  );
  if (labelled) {
    const checked = validateText(labelled.text, 'Supplier name');
    if (checked.ok && !OWN_COMPANY_PATTERNS.some(p => p.test(checked.value as string))) {
      return valid(checked.value as string, 'DETERMINISTIC', 0.9);
    }
  }

  // Unlabelled: the letterhead. Only the top of the page is considered — a
  // company name further down is as likely to be the customer or a haulier.
  const header = lines.slice(0, 6).filter(line => !OWN_COMPANY_PATTERNS.some(p => p.test(line)));

  const withSuffix = header.find(line => COMPANY_SUFFIX.test(line) && validateText(line, 'Supplier name').ok);
  if (withSuffix) {
    const checked = validateText(withSuffix, 'Supplier name');
    return valid(checked.value as string, 'DETERMINISTIC', 0.85);
  }

  const firstUsable = header.find(line => validateText(line, 'Supplier name', { minLength: 3 }).ok);
  if (firstUsable) {
    const checked = validateText(firstUsable, 'Supplier name');
    // Deliberately below the trust threshold: this is the top line of the page
    // and nothing more. It is offered to the fallback model and always reviewed.
    return valid(checked.value as string, 'DETERMINISTIC', 0.5);
  }

  return missing('No supplier name on the ticket');
}

function buildTicketNumber(lines: string[]): ExtractedField<string> {
  const labelled = findLabelled(
    lines,
    /\b(?:weigh(?:t)?\s+)?(?:ticket|slip|load)(?!\s+(?:date|time|type)\b)\s*(?:number|no\.?|num|#)?\s*[:#-]?/i,
    ALNUM_ID
  );
  if (!labelled) return missing('No ticket number on the ticket');

  const checked = validateText(labelled.text.replace(/\s+/g, ''), 'Ticket number', { minLength: 3 });
  if (!checked.ok) return invalid('DETERMINISTIC', checked.reason as string);
  return valid(checked.value as string, 'DETERMINISTIC', labelled.sameLine ? 0.9 : 0.8);
}

function buildDate(lines: string[], now: Date): ExtractedField<string> {
  const labelled = findLabelled(lines, /\b(date|shipped|delivered|weighed)\b\s*[:#-]?/i, DATE_TEXT);
  if (labelled) {
    const checked = validateDate(labelled.text, now);
    if (checked.ok) {
      return valid(checked.value as string, 'DETERMINISTIC', 0.9 * checked.confidenceFactor);
    }
  }

  // Unlabelled: the first thing on the page that is a real, in-range date.
  for (const line of lines) {
    const match = line.match(DATE_TEXT);
    if (!match?.[1]) continue;
    const checked = validateDate(match[1], now);
    if (checked.ok) {
      return valid(checked.value as string, 'DETERMINISTIC', 0.65 * checked.confidenceFactor);
    }
  }

  if (labelled) return invalid('DETERMINISTIC', validateDate(labelled.text, now).reason as string);
  return missing('No ticket date on the ticket');
}

function buildPoNumber(lines: string[]): ExtractedField<string> {
  const labelled = findLabelled(
    lines,
    /\b(p\.?\s*o\.?|purchase\s*order|customer\s*order|job|order)\s*(number|no\.?|num|#)?\s*[:#-]?/i,
    /(\d{6})\b/
  );
  if (!labelled) return missing('No six-digit PO number on the ticket');

  const checked = validatePoNumber(labelled.text);
  if (!checked.ok) return invalid('DETERMINISTIC', checked.reason as string);
  return valid(checked.value as string, 'DETERMINISTIC', labelled.sameLine ? 0.9 : 0.8);
}

function buildMaterial(lines: string[]): ExtractedField<string> {
  const labelled = findLabelled(
    lines,
    /\b(material|product|description|commodity|item)\b\s*[:#-]?/i,
    /(.+)/
  );
  if (labelled) {
    const checked = validateText(labelled.text, 'Material');
    if (checked.ok) return valid(checked.value as string, 'DETERMINISTIC', 0.9);
  }

  const keywordLine = lines.find(
    line =>
      MATERIAL_KEYWORDS.test(line) &&
      !/\b(?:ltd|limited|inc|incorporated|corp|corporation|company)\b\.?/i.test(line)
  );
  if (keywordLine) {
    const checked = validateText(keywordLine, 'Material');
    if (checked.ok) return valid(checked.value as string, 'DETERMINISTIC', 0.6);
  }

  return missing('No material description on the ticket');
}

/**
 * The delivered quantity.
 *
 * NET is preferred over anything else: a scale ticket prints GROSS, TARE and NET,
 * and gross is the truck. Billing against gross weight would overstate every
 * load by the mass of the vehicle.
 */
function buildQuantity(lines: string[]): { field: ExtractedField<number>; rawLine: string } {
  const net = findLabelledLine(lines, /\bnet\b(?!\s*(30|60|90))\s*(weight|wt\.?|qty|quantity)?\s*[:#-]?/i, NUMBER);
  if (net) {
    const checked = validateQuantity(net.text);
    if (checked.ok) {
      return { field: valid(checked.value as number, 'DETERMINISTIC', 0.9), rawLine: net.line };
    }
  }

  const qty = findLabelledLine(lines, /\b(quantity|qty|weight|amount|units?)\b\s*[:#-]?/i, NUMBER);
  if (qty) {
    const checked = validateQuantity(qty.text);
    if (checked.ok) {
      return { field: valid(checked.value as number, 'DETERMINISTIC', 0.75), rawLine: qty.line };
    }
    return { field: invalid('DETERMINISTIC', checked.reason as string), rawLine: qty.line };
  }

  // Last resort: a number immediately followed by a unit we recognise.
  for (const line of lines) {
    const match = line.match(/(\d[\d,]*\.?\d*)\s*([A-Za-z][A-Za-z.]{0,12})/);
    if (!match?.[1] || !match[2]) continue;
    if (!validateUnit(match[2].replace(/\.$/, '')).ok) continue;
    const checked = validateQuantity(match[1]);
    if (checked.ok) {
      return { field: valid(checked.value as number, 'DETERMINISTIC', 0.6), rawLine: line };
    }
  }

  return { field: missing('No delivered quantity on the ticket'), rawLine: '' };
}

/** As findLabelled, but reports the line the value came from so the unit can be read beside it. */
function findLabelledLine(
  lines: string[],
  label: RegExp,
  valuePattern: RegExp
): { text: string; line: string } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const labelMatch = line.match(label);
    if (!labelMatch || labelMatch.index === undefined) continue;

    const afterLabel = line.slice(labelMatch.index + labelMatch[0].length);
    const inline = afterLabel.match(valuePattern);
    if (inline?.[1]) return { text: inline[1], line };

    const next = lines[index + 1];
    if (next && !looksLikeLabelledLine(next)) {
      const below = next.match(valuePattern);
      if (below?.[1]) return { text: below[1], line: next };
    }
  }
  return null;
}

/**
 * The unit the quantity is measured in. Never defaulted.
 *
 * Read from beside the quantity itself, so a "per tonne" in a rate footer cannot
 * be mistaken for the unit of the load.
 */
function buildUnit(lines: string[], quantityLine: string, quantity: number | null): ExtractedField<string> {
  const labelled = findLabelled(lines, /\b(unit|uom|units?\s*of\s*measure)\b\s*[:#-]?/i, /([A-Za-z]{1,12})/);
  if (labelled) {
    const checked = validateUnit(labelled.text);
    if (checked.ok) return valid(checked.value as string, 'DETERMINISTIC', 0.9);
  }

  if (quantityLine && quantity !== null) {
    const pattern = /(\d[\d,]*\.?\d*)\s*([A-Za-z][A-Za-z.]{0,12})/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(quantityLine)) !== null) {
      const numeric = Number((match[1] as string).replace(/,/g, ''));
      if (!Number.isFinite(numeric) || Math.abs(numeric - quantity) > 1e-6) continue;
      const candidate = (match[2] as string).replace(/\.$/, '');
      if (validateUnit(candidate).ok) return valid(candidate, 'DETERMINISTIC', 0.85);
    }
  }

  if (labelled) {
    return invalid('DETERMINISTIC', validateUnit(labelled.text).reason as string);
  }
  return missing('No unit of measure on the ticket');
}
