import { z } from 'zod';

/**
 * The shapes a document extraction is allowed to return.
 *
 * These are enforced by the provider's structured-output mode, not by parsing
 * prose. The service they replaced asked a model for "ONLY a valid JSON object"
 * and then dug the JSON back out with a regex, so a chatty answer, a truncated
 * reply or a number rendered as `"12 tons"` all reached the database as junk —
 * which is why the ticket writer downstream grew a block of code coercing
 * arrays and objects back into scalars. A response that does not fit these
 * schemas now fails the job instead of being repaired by guesswork.
 *
 * Structured outputs require every property to be present, so a field that may
 * be absent is `.nullable()`, never `.optional()`. Null means "not on the
 * document"; it must never mean "the model did not bother".
 */

/** How legible the document was. Drives the stored confidence figure. */
export const ReadabilitySchema = z.enum(['clear', 'partly_legible', 'poor']);
export type Readability = z.infer<typeof ReadabilitySchema>;

/**
 * Confidence written to `Ticket.ocrConfidence` / job records.
 *
 * The number this replaces was Textract's character-recognition confidence,
 * which described how sure it was of the *letters* and said nothing about
 * whether the right field had been read. This is coarser but honest: it is the
 * model's own account of how readable the document was.
 */
export const READABILITY_CONFIDENCE: Record<Readability, number> = {
  clear: 0.95,
  partly_legible: 0.7,
  poor: 0.4,
};

export const TicketExtractionSchema = z.object({
  supplierName: z.string().nullable(),
  /** ISO `YYYY-MM-DD` as read; converted to a Date in normalize.ts. */
  date: z.string().nullable(),
  ticketNumber: z.string().nullable(),
  poNumber: z.string().nullable(),
  material: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  readability: ReadabilitySchema,
  /**
   * Names of fields above the model was unsure of, e.g. a smudged quantity it
   * read as 24.6 but could not swear to. The value still comes back — this
   * marks it for a human rather than discarding it.
   */
  uncertainFields: z.array(z.string()),
});
export type TicketExtraction = z.infer<typeof TicketExtractionSchema>;

export const InvoiceLineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.number().nullable(),
  totalPrice: z.number().nullable(),
  /** Line-level PO. Present on most supplier invoices, and more reliable than the header one. */
  poNumber: z.string().nullable(),
});
export type InvoiceLineItemExtraction = z.infer<typeof InvoiceLineItemSchema>;

export const InvoiceExtractionSchema = z.object({
  supplierName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  date: z.string().nullable(),
  poNumber: z.string().nullable(),
  totalAmount: z.number().nullable(),
  lineItems: z.array(InvoiceLineItemSchema),
  readability: ReadabilitySchema,
  uncertainFields: z.array(z.string()),
});
export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;
