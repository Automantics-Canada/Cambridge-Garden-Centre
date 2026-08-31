/**
 * The shape every document extraction produces, whatever read it.
 *
 * The previous pipeline handed Textract's raw text straight to a language model
 * and wrote whatever JSON came back into the ledger. Nothing downstream could
 * tell an amount Textract had read off the page from one the model had invented,
 * so a hallucinated unit rate and a scanned one were persisted identically.
 *
 * Every value below therefore travels with where it came from, how sure we are,
 * and whether it survived validation. Callers are expected to branch on that —
 * a field is not a number, it is a number plus its provenance.
 */

/**
 * Where a value came from.
 *
 * TEXTRACT      read directly off the document by AWS Textract
 * DETERMINISTIC derived from the OCR text by our own parsing rules
 * GROQ          proposed by the fallback model; a candidate, never authority
 */
export type FieldSource = 'TEXTRACT' | 'DETERMINISTIC' | 'GROQ';

/**
 * Whether the value may be used.
 *
 * MISSING  nothing was found
 * INVALID  something was found but it failed validation (and is not used)
 * VALID    present and validated
 */
export type ValidationState = 'MISSING' | 'INVALID' | 'VALID';

export interface ExtractedField<T> {
  value: T | null;
  source: FieldSource | null;
  /** 0..1. Textract's own score where it gave one, otherwise our rule's score. */
  confidence: number;
  state: ValidationState;
  /** Why the field is MISSING or INVALID. Null when VALID. */
  reason: string | null;
}

/**
 * A field is trusted when it validated *and* the read was confident.
 *
 * This is the gate that stops the fallback model touching good data: anything
 * that passes here is never offered to Groq and can never be overwritten by it.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;

export function isTrusted<T>(field: ExtractedField<T>): boolean {
  return field.state === 'VALID' && field.confidence >= HIGH_CONFIDENCE_THRESHOLD;
}

export function missing<T>(reason = 'Not found on the document'): ExtractedField<T> {
  return { value: null, source: null, confidence: 0, state: 'MISSING', reason };
}

export function valid<T>(
  value: T,
  source: FieldSource,
  confidence: number
): ExtractedField<T> {
  return {
    value,
    source,
    confidence: clampConfidence(confidence),
    state: 'VALID',
    reason: null,
  };
}

export function invalid<T>(
  source: FieldSource,
  reason: string,
  confidence = 0
): ExtractedField<T> {
  // The rejected value is deliberately not carried forward. Keeping it invited
  // callers to reach past `state` and use it anyway.
  return { value: null, source, confidence: clampConfidence(confidence), state: 'INVALID', reason };
}

export function clampConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/** Textract reports confidence as a percentage; everything here is a fraction. */
export function fromTextractConfidence(raw: number | undefined | null): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return clampConfidence(raw / 100);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface InvoiceLineExtraction {
  description: ExtractedField<string>;
  quantity: ExtractedField<number>;
  /** The unit as written on the document, once recognised. Never defaulted. */
  unit: ExtractedField<string>;
  unitRate: ExtractedField<number>;
  lineTotal: ExtractedField<number>;
  poNumber: ExtractedField<string>;
}

export interface InvoiceExtraction {
  supplierName: ExtractedField<string>;
  invoiceNumber: ExtractedField<string>;
  /** ISO calendar date, `YYYY-MM-DD`. Kept as a string so no timezone is implied. */
  invoiceDate: ExtractedField<string>;
  poNumber: ExtractedField<string>;
  total: ExtractedField<number>;
  lines: InvoiceLineExtraction[];
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export interface TicketExtraction {
  supplierName: ExtractedField<string>;
  ticketNumber: ExtractedField<string>;
  ticketDate: ExtractedField<string>;
  poNumber: ExtractedField<string>;
  material: ExtractedField<string>;
  quantity: ExtractedField<number>;
  unit: ExtractedField<string>;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Why a document needs a person. One code per distinct problem. */
export interface ReviewIssue {
  /** Dotted path, e.g. `total` or `lines.0.unitRate`. */
  field: string;
  code: ReviewIssueCode;
  /** Short, safe to show on screen. Never contains document contents. */
  message: string;
}

export type ReviewIssueCode =
  | 'MISSING_FIELD'
  | 'INVALID_FIELD'
  | 'LOW_CONFIDENCE'
  | 'LINE_ARITHMETIC'
  | 'TOTAL_MISMATCH'
  | 'NO_LINE_ITEMS'
  | 'UNRESOLVED_SUPPLIER'
  | 'FALLBACK_SOURCED'
  | 'FALLBACK_UNAVAILABLE'
  | 'FALLBACK_REJECTED';

export interface FallbackMetadata {
  used: boolean;
  /** Why the fallback was reached for, or why it was skipped. */
  reason:
    | 'NOT_NEEDED'
    | 'DISABLED'
    | 'NOT_CONFIGURED'
    | 'REQUESTED'
    | 'FAILED'
    | 'REJECTED';
  model: string | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Field paths the model was asked about. Paths only — never values. */
  requestedFields: string[];
  /** Field paths the model actually filled and that then validated. */
  acceptedFields: string[];
}

export interface ExtractionOutcome<T> {
  fields: T;
  /** The OCR text itself. Stored separately from provenance, never sent onward. */
  ocrText: string;
  /** Mean Textract line confidence, 0..1. */
  ocrConfidence: number;
  issues: ReviewIssue[];
  fallback: FallbackMetadata;
  /**
   * True only when every required field validated and nothing came from the
   * fallback model. This is the sole condition under which a job may complete
   * without a person looking at it.
   */
  complete: boolean;
}

export const EXTRACTION_PROVIDER = 'AWS_TEXTRACT_DETERMINISTIC';
