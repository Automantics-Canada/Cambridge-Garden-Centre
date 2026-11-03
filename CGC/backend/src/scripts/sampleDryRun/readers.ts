/**
 * Who answers when the dry run asks the reader about a sample.
 *
 * The dry run calls the production extraction functions (triageDocument,
 * extractInvoice, extractTicket) so the whole reading path runs as it does
 * for an emailed invoice: size checks, spreadsheet to text, the prompt, the
 * schema and the normalisation. Only the model's reply is swapped:
 *
 *   - fixture mode answers from a `<file>.extraction.json` written earlier,
 *     so a run needs no key, no network and costs nothing (and is what the
 *     tests use);
 *   - live mode passes the call to the real provider and keeps a copy of the
 *     reply, which --save-extractions writes out for later offline runs.
 */
import type { z } from 'zod';
import {
  ExtractionError,
  type ExtractionDocument,
  type ExtractionProvider,
} from '../../services/extraction/providers/types.js';
import type { ExtractionFixture } from './sampleFiles.js';

/** The replies to one sample, in the shape of a `<file>.extraction.json`. */
export interface CapturedReplies {
  triage?: unknown;
  invoice?: unknown;
  tickets?: Record<string, unknown>;
}

export interface ReaderSession {
  provider: ExtractionProvider;
  /** The page the next ticket call is for (1 for a file that is one ticket). */
  setPage(page: number): void;
  captured: CapturedReplies;
  /** Things worth telling the person, e.g. a saved reply that no longer fits the schema. */
  warnings: string[];
}

const SCHEMA_NAMES = {
  triage: 'attachment_triage',
  invoice: 'supplier_invoice',
  ticket: 'delivery_ticket',
} as const;

/** Raw invoice lines as the model returned them, for fields this build's reader drops. */
export function rawInvoiceLines(captured: CapturedReplies): Array<Record<string, unknown>> | null {
  const invoice = captured.invoice as { lineItems?: unknown } | undefined;
  return Array.isArray(invoice?.lineItems) ? (invoice.lineItems as Array<Record<string, unknown>>) : null;
}

export function fixtureReader(fixture: ExtractionFixture | null, file: string): ReaderSession {
  let page = 1;
  const warnings: string[] = [];
  const captured: CapturedReplies = {};

  /**
   * The saved reply, checked against the schema production uses now. A reply
   * saved before the schema gained a field still loads (sampleFiles.ts fills
   * it as null); one that does not fit at all is passed on with a warning, so
   * the report shows what the reader would make of it rather than nothing.
   */
  const conform = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    warnings.push(
      `${what} in ${file}.extraction.json does not fit the current reader's schema: ` +
        parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')
    );
    return value as T;
  };

  const provider: ExtractionProvider = {
    name: 'pre-extracted',
    modelId: 'fixture',
    async extract<T>(_document: ExtractionDocument, _prompt: string, schema: z.ZodType<T>, schemaName: string): Promise<T> {
      if (schemaName === SCHEMA_NAMES.triage) {
        if (fixture?.triage) {
          captured.triage = fixture.triage;
          return conform(schema, fixture.triage, 'The triage');
        }
        // No sorting saved: the whole file is read as one invoice, which is
        // also what production does when sorting is refused.
        warnings.push('No page sorting in the pre-extracted file; the whole file was read as one invoice');
        const whole = { pages: [{ page: 1, kind: 'invoice' }] };
        captured.triage = whole;
        return whole as T;
      }
      if (schemaName === SCHEMA_NAMES.invoice) {
        if (!fixture?.invoice) {
          throw new ExtractionError(`No invoice reading in ${file}.extraction.json`, { retryable: false });
        }
        captured.invoice = fixture.invoice;
        return conform(schema, fixture.invoice, 'The invoice reading');
      }
      if (schemaName === SCHEMA_NAMES.ticket) {
        const reply = fixture?.tickets?.[String(page)];
        if (!reply) {
          throw new ExtractionError(`No ticket reading for page ${page} in ${file}.extraction.json`, { retryable: false });
        }
        captured.tickets = { ...captured.tickets, [String(page)]: reply };
        return conform(schema, reply, `The ticket reading for page ${page}`);
      }
      throw new ExtractionError(`The sample dry run does not answer "${schemaName}"`, { retryable: false });
    },
  };

  return { provider, setPage: (next) => void (page = next), captured, warnings };
}

/** The real provider, with every reply kept. */
export function recordingReader(real: ExtractionProvider): ReaderSession {
  let page = 1;
  const captured: CapturedReplies = {};
  const provider: ExtractionProvider = {
    name: real.name,
    modelId: real.modelId,
    async extract(document, prompt, schema, schemaName, options) {
      const reply = await real.extract(document, prompt, schema, schemaName, options);
      if (schemaName === SCHEMA_NAMES.triage) captured.triage = reply;
      else if (schemaName === SCHEMA_NAMES.invoice) captured.invoice = reply;
      else if (schemaName === SCHEMA_NAMES.ticket) captured.tickets = { ...captured.tickets, [String(page)]: reply };
      return reply;
    },
  };
  return { provider, setPage: (next) => void (page = next), captured, warnings: [] };
}
