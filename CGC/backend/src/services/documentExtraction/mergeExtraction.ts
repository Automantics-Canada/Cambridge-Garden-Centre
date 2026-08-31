/**
 * Deciding what still needs asking about, merging what comes back, and judging
 * whether the result may be posted without a person.
 *
 * The order matters and is the whole point of the design:
 *
 *   deterministic extraction
 *     → work out which fields are actually unresolved
 *     → ask the fallback about exactly those, once
 *     → validate each answer the same way a Textract answer is validated
 *     → merge, never over a trusted field
 *     → re-check the arithmetic across the merged result
 *     → complete, or NEEDS_REVIEW
 *
 * The fallback is skipped entirely when the deterministic pass left nothing
 * unresolved, which on a clean invoice is the normal case.
 */

import {
  isTrusted,
  valid,
  type ExtractedField,
  type ExtractionOutcome,
  type FallbackMetadata,
  type InvoiceExtraction,
  type InvoiceLineExtraction,
  type ReviewIssue,
  type TicketExtraction,
} from './types.js';
import {
  checkLineArithmetic,
  checkTotalPlausibility,
  validateCadAmount,
  validateDate,
  validatePoNumber,
  validateQuantity,
  validateRate,
  validateText,
  validateUnit,
  type Validated,
} from './validation.js';
import {
  fallbackUnavailableReason,
  requestFallbackFields,
  type FallbackFieldSpec,
} from './groqFallback.service.js';

/**
 * The confidence a fallback-sourced value carries.
 *
 * Fixed, and deliberately below the trust threshold. The model reports its own
 * certainty, and that number measures how fluent the answer felt, not whether it
 * is on the page — so it is not read. A value from here is always shown to a
 * person before it is acted on.
 */
export const FALLBACK_CONFIDENCE = 0.6;

/** Field descriptions sent to the model. Static text; never document content. */
type FieldPlan = {
  path: string;
  description: string;
  /** Whether the document is unusable without it. */
  required: boolean;
  get: () => ExtractedField<unknown>;
  set: (raw: string) => Validated<unknown>;
  apply: (value: unknown) => void;
};

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

function invoicePlan(extraction: InvoiceExtraction): FieldPlan[] {
  const plans: FieldPlan[] = [
    {
      path: 'supplierName',
      description: 'The company issuing the invoice, not the bill-to customer.',
      required: true,
      get: () => extraction.supplierName,
      set: raw => validateText(raw, 'Supplier name'),
      apply: value => {
        extraction.supplierName = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'invoiceNumber',
      description: "The supplier's invoice number.",
      required: true,
      get: () => extraction.invoiceNumber,
      set: raw => validateText(raw, 'Invoice number'),
      apply: value => {
        extraction.invoiceNumber = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'invoiceDate',
      description: 'The invoice date, exactly as printed.',
      required: true,
      get: () => extraction.invoiceDate,
      set: raw => validateDate(raw),
      apply: value => {
        extraction.invoiceDate = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'poNumber',
      description: 'The six-digit purchase order number for the invoice as a whole.',
      required: false,
      get: () => extraction.poNumber,
      set: raw => validatePoNumber(raw),
      apply: value => {
        extraction.poNumber = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'total',
      description: 'The total amount payable in Canadian dollars.',
      required: true,
      get: () => extraction.total,
      set: raw => validateCadAmount(raw, 'Invoice total'),
      apply: value => {
        extraction.total = valid(value as number, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
  ];

  extraction.lines.forEach((line, index) => {
    plans.push(
      {
        path: `lines.${index}.description`,
        description: 'The product or service described on this line.',
        required: true,
        get: () => line.description,
        set: raw => validateText(raw, 'Description'),
        apply: value => {
          line.description = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
        },
      },
      {
        path: `lines.${index}.quantity`,
        description: 'The quantity billed on this line, digits only.',
        required: true,
        get: () => line.quantity,
        set: raw => validateQuantity(raw),
        apply: value => {
          line.quantity = valid(value as number, 'GROQ', FALLBACK_CONFIDENCE);
        },
      },
      {
        path: `lines.${index}.unit`,
        description: 'The unit of measure for this line as printed, e.g. tonnes, tons, cy. Null if absent.',
        required: true,
        get: () => line.unit,
        set: raw => validateUnit(raw),
        apply: value => {
          line.unit = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
        },
      },
      {
        path: `lines.${index}.unitRate`,
        description: 'The price per unit on this line.',
        required: true,
        get: () => line.unitRate,
        set: raw => validateRate(raw),
        apply: value => {
          line.unitRate = valid(value as number, 'GROQ', FALLBACK_CONFIDENCE);
        },
      },
      {
        path: `lines.${index}.lineTotal`,
        description: 'The extended amount for this line.',
        required: true,
        get: () => line.lineTotal,
        set: raw => validateCadAmount(raw, 'Line total'),
        apply: value => {
          line.lineTotal = valid(value as number, 'GROQ', FALLBACK_CONFIDENCE);
        },
      },
      {
        path: `lines.${index}.poNumber`,
        description: 'The six-digit purchase order number for this line.',
        required: false,
        get: () => line.poNumber,
        set: raw => validatePoNumber(raw),
        apply: value => {
          line.poNumber = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
        },
      }
    );
  });

  return plans;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

function ticketPlan(extraction: TicketExtraction): FieldPlan[] {
  return [
    {
      path: 'supplierName',
      description: 'The company issuing the ticket, not the bill-to customer.',
      required: true,
      get: () => extraction.supplierName,
      set: raw => validateText(raw, 'Supplier name'),
      apply: value => {
        extraction.supplierName = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'ticketNumber',
      description: 'The ticket or weigh-slip number.',
      required: true,
      get: () => extraction.ticketNumber,
      set: raw => validateText(raw, 'Ticket number', { minLength: 3 }),
      apply: value => {
        extraction.ticketNumber = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'ticketDate',
      description: 'The date of the delivery, exactly as printed.',
      required: true,
      get: () => extraction.ticketDate,
      set: raw => validateDate(raw),
      apply: value => {
        extraction.ticketDate = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'poNumber',
      description: 'The six-digit purchase order number.',
      required: true,
      get: () => extraction.poNumber,
      set: raw => validatePoNumber(raw),
      apply: value => {
        extraction.poNumber = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'material',
      description: 'The material delivered, e.g. A Gravel, HPB, screened sand.',
      required: false,
      get: () => extraction.material,
      set: raw => validateText(raw, 'Material'),
      apply: value => {
        extraction.material = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'quantity',
      description: 'The net quantity delivered, digits only. Use net weight, never gross.',
      required: true,
      get: () => extraction.quantity,
      set: raw => validateQuantity(raw),
      apply: value => {
        extraction.quantity = valid(value as number, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
    {
      path: 'unit',
      description: 'The unit the quantity is measured in as printed, e.g. tonnes, tons. Null if absent.',
      required: true,
      get: () => extraction.unit,
      set: raw => validateUnit(raw),
      apply: value => {
        extraction.unit = valid(value as string, 'GROQ', FALLBACK_CONFIDENCE);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface FinaliseInput<T> {
  extraction: T;
  ocrText: string;
  ocrConfidence: number;
  documentType: 'INVOICE' | 'TICKET';
  jobId: string;
}

export async function finaliseInvoiceExtraction(
  input: FinaliseInput<InvoiceExtraction>
): Promise<ExtractionOutcome<InvoiceExtraction>> {
  const fallback = await runFallback(input.extraction, invoicePlan, input);
  const issues = reviewInvoice(input.extraction, fallback);
  return assemble(input, issues, fallback);
}

export async function finaliseTicketExtraction(
  input: FinaliseInput<TicketExtraction>
): Promise<ExtractionOutcome<TicketExtraction>> {
  const fallback = await runFallback(input.extraction, ticketPlan, input);
  const issues = reviewTicket(input.extraction, fallback);
  return assemble(input, issues, fallback);
}

function assemble<T>(
  input: FinaliseInput<T>,
  issues: ReviewIssue[],
  fallback: FallbackMetadata
): ExtractionOutcome<T> {
  return {
    fields: input.extraction,
    ocrText: input.ocrText,
    ocrConfidence: input.ocrConfidence,
    issues,
    fallback,
    complete: issues.length === 0,
  };
}

/**
 * Ask the fallback about the unresolved fields, once.
 *
 * "Once" is enforced structurally rather than by a counter: every eligible field
 * goes into a single request, and there is no path that issues a second one for
 * the same document. A partial answer leaves the rest unresolved for a person,
 * which is the correct outcome and cheaper than another round trip.
 */
async function runFallback<T>(
  extraction: T,
  buildPlan: (extraction: T) => FieldPlan[],
  input: FinaliseInput<T>
): Promise<FallbackMetadata> {
  const plan = buildPlan(extraction);
  const eligible = plan.filter(field => {
    const current = field.get();
    if (isTrusted(current)) return false;

    // Optional means the document is valid without the field. Asking Groq for
    // an absent optional value made an otherwise complete document depend on
    // fallback availability and turned a null answer into NEEDS_REVIEW.
    if (!field.required && current.state === 'MISSING') return false;
    return true;
  });

  const base: FallbackMetadata = {
    used: false,
    reason: 'NOT_NEEDED',
    model: null,
    durationMs: null,
    promptTokens: null,
    completionTokens: null,
    requestedFields: [],
    acceptedFields: [],
  };

  // The clean-document path: everything validated at high confidence, so no
  // request is made and no money is spent.
  if (eligible.length === 0) return base;

  const unavailable = fallbackUnavailableReason();
  if (unavailable) {
    return { ...base, reason: unavailable, requestedFields: eligible.map(f => f.path) };
  }

  const specs: FallbackFieldSpec[] = eligible.map(field => ({
    path: field.path,
    description: field.description,
  }));

  const result = await requestFallbackFields({
    documentType: input.documentType,
    fields: specs,
    ocrText: input.ocrText,
    jobId: input.jobId,
  });

  if (!result.ok) {
    return {
      ...base,
      reason: result.reason === 'DISABLED' || result.reason === 'NOT_CONFIGURED' ? result.reason : 'FAILED',
      model: result.meta.model,
      durationMs: result.meta.durationMs,
      requestedFields: specs.map(spec => spec.path),
    };
  }

  const accepted = mergeFallbackValues(eligible, result.values);

  return {
    used: accepted.length > 0,
    reason: accepted.length > 0 ? 'REQUESTED' : 'REJECTED',
    model: result.meta.model,
    durationMs: result.meta.durationMs,
    promptTokens: result.meta.promptTokens,
    completionTokens: result.meta.completionTokens,
    requestedFields: specs.map(spec => spec.path),
    acceptedFields: accepted,
  };
}

/**
 * Write the accepted answers back.
 *
 * Two gates, both of which have to hold:
 *
 *  - the field is re-checked for trust at the moment of writing, so even a bug
 *    that put a trusted field into the request cannot overwrite it here;
 *  - the answer goes through the field's own validator, so a fallback value is
 *    held to the same standard as a Textract one and a malformed answer is
 *    dropped rather than stored.
 */
function mergeFallbackValues(
  eligible: FieldPlan[],
  values: Record<string, string | null>
): string[] {
  const accepted: string[] = [];

  for (const field of eligible) {
    if (isTrusted(field.get())) continue;

    const raw = values[field.path];
    if (raw === null || raw === undefined || raw.trim() === '') continue;

    const checked = field.set(raw);
    // A fallback answer that fails validation is dropped and the field stays
    // unresolved, exactly as if the model had returned null.
    if (!checked.ok) continue;

    field.apply(checked.value);
    accepted.push(field.path);
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function fieldIssues(plan: FieldPlan[], issues: ReviewIssue[]): void {
  for (const field of plan) {
    const current = field.get();

    if (current.state === 'MISSING') {
      if (field.required) {
        issues.push({ field: field.path, code: 'MISSING_FIELD', message: current.reason ?? 'Not found' });
      }
      continue;
    }
    if (current.state === 'INVALID') {
      issues.push({ field: field.path, code: 'INVALID_FIELD', message: current.reason ?? 'Failed validation' });
      continue;
    }
    if (current.source === 'GROQ') {
      issues.push({
        field: field.path,
        code: 'FALLBACK_SOURCED',
        message: 'Read by the fallback model; confirm against the document',
      });
      continue;
    }
    if (!isTrusted(current)) {
      issues.push({
        field: field.path,
        code: 'LOW_CONFIDENCE',
        message: `Read with low confidence (${Math.round(current.confidence * 100)}%)`,
      });
    }
  }
}

function fallbackIssues(fallback: FallbackMetadata, issues: ReviewIssue[]): void {
  if (fallback.reason === 'DISABLED' || fallback.reason === 'NOT_CONFIGURED') {
    issues.push({
      field: 'fallback',
      code: 'FALLBACK_UNAVAILABLE',
      message:
        fallback.reason === 'DISABLED'
          ? 'Fields were unresolved and the fallback reader is switched off'
          : 'Fields were unresolved and the fallback reader is not configured',
    });
  }
  if (fallback.reason === 'FAILED') {
    issues.push({
      field: 'fallback',
      code: 'FALLBACK_UNAVAILABLE',
      message: 'Fields were unresolved and the fallback reader could not be reached',
    });
  }
  if (fallback.reason === 'REJECTED') {
    issues.push({
      field: 'fallback',
      code: 'FALLBACK_REJECTED',
      message: 'The fallback reader answered but nothing it returned passed validation',
    });
  }
}

export function reviewInvoice(
  extraction: InvoiceExtraction,
  fallback: FallbackMetadata
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  if (extraction.lines.length === 0) {
    issues.push({
      field: 'lines',
      code: 'NO_LINE_ITEMS',
      message: 'No line items could be read from the invoice',
    });
  }

  fieldIssues(invoicePlan(extraction), issues);
  fallbackIssues(fallback, issues);

  // Arithmetic is re-checked after the merge, not before: a line whose rate came
  // from the fallback must still add up against the quantity Textract read.
  extraction.lines.forEach((line, index) => {
    const arithmetic = checkLineArithmetic(
      line.quantity.value,
      line.unitRate.value,
      line.lineTotal.value
    );
    if (arithmetic.checked && !arithmetic.agrees) {
      issues.push({
        field: `lines.${index}`,
        code: 'LINE_ARITHMETIC',
        message: `Quantity x rate is ${(arithmetic.expected as number).toFixed(2)} but the line total reads ${(line.lineTotal.value as number).toFixed(2)}`,
      });
    }
  });

  const lineTotals = extraction.lines
    .map(line => line.lineTotal.value)
    .filter((value): value is number => value !== null);

  const totals = checkTotalPlausibility(lineTotals, extraction.total.value);
  if (totals.checked && !totals.agrees) {
    issues.push({
      field: 'total',
      code: 'TOTAL_MISMATCH',
      message: `Line items add to ${totals.lineSum.toFixed(2)} before tax, which does not support a total of ${(extraction.total.value as number).toFixed(2)}`,
    });
  }

  return issues;
}

export function reviewTicket(
  extraction: TicketExtraction,
  fallback: FallbackMetadata
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  fieldIssues(ticketPlan(extraction), issues);
  fallbackIssues(fallback, issues);
  return issues;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * The compact record stored on the OCR job.
 *
 * One entry per field: what was read, where it came from, how sure we are, and
 * whether it survived validation. This is what the review desk works from when a
 * document is held back — the reviewer needs to see the candidate values in
 * order to confirm or correct them, and on a NEEDS_REVIEW document those values
 * deliberately have not been written to the invoice itself.
 *
 * It is not a copy of the provider response. The Textract payload, the page
 * geometry and the OCR text all stay out of it; the OCR text is stored once, in
 * its own column, where it belongs.
 */
export interface StoredProvenance {
  fields: Record<
    string,
    { value: unknown; source: string | null; confidence: number; state: string; reason: string | null }
  >;
  issues: ReviewIssue[];
  fallback: FallbackMetadata;
  ocrConfidence: number;
  complete: boolean;
}

export function buildInvoiceProvenance(
  outcome: ExtractionOutcome<InvoiceExtraction>
): StoredProvenance {
  return buildProvenance(invoicePlan(outcome.fields), outcome);
}

export function buildTicketProvenance(
  outcome: ExtractionOutcome<TicketExtraction>
): StoredProvenance {
  return buildProvenance(ticketPlan(outcome.fields), outcome);
}

function buildProvenance<T>(plan: FieldPlan[], outcome: ExtractionOutcome<T>): StoredProvenance {
  const fields: StoredProvenance['fields'] = {};
  for (const field of plan) {
    const current = field.get();
    fields[field.path] = {
      value: current.value,
      source: current.source,
      confidence: Number(current.confidence.toFixed(3)),
      state: current.state,
      reason: current.reason,
    };
  }
  return {
    fields,
    issues: outcome.issues,
    fallback: outcome.fallback,
    ocrConfidence: Number(outcome.ocrConfidence.toFixed(3)),
    complete: outcome.complete,
  };
}

/** Short, human-readable reasons for the review desk. Deduplicated, bounded. */
export function summariseReviewReasons(issues: ReviewIssue[], limit = 12): string[] {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const issue of issues) {
    const text = `${issue.field}: ${issue.message}`;
    if (seen.has(text)) continue;
    seen.add(text);
    reasons.push(text);
    if (reasons.length >= limit) break;
  }
  return reasons;
}
