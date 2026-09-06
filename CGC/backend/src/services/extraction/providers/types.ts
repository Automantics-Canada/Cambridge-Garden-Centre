import type { z } from 'zod';

/**
 * The seam every extraction provider implements.
 *
 * Only files in this directory know which company reads our documents. The
 * prompts, the Zod schemas and the normalisation downstream are all provider
 * neutral, so changing provider is one new file here plus a config value — it
 * is not a rewrite. That mattered enough to design for: this pipeline has
 * already been through AWS Textract + Bedrock, was briefly going to be Groq,
 * and shipped on OpenAI.
 */

/** One document, in memory, on its way to a model. */
export interface ExtractionDocument {
  bytes: Buffer;
  /** e.g. `image/jpeg`, `application/pdf`. Decides how the file is attached. */
  mimeType: string;
  /** Used by providers that require a filename alongside file bytes. */
  filename: string;
}

export interface ExtractionProvider {
  /** For logs and for the eval script's report header. */
  readonly name: string;
  readonly modelId: string;
  /**
   * Read one document and return a value matching `schema`.
   *
   * Implementations must either return a schema-valid value or throw an
   * {@link ExtractionError}. Returning a partially filled object on a bad
   * response is forbidden — a half-read invoice that looks like a whole one is
   * exactly the failure this pipeline is built to avoid.
   */
  extract<T>(
    document: ExtractionDocument,
    prompt: string,
    schema: z.ZodType<T>,
    schemaName: string
  ): Promise<T>;
}

/**
 * A failed extraction, and whether trying again could plausibly work.
 *
 * `retryable` decides whether the OCR job goes back into the queue with
 * backoff or stops and waits for a person. Rate limits and upstream 5xx are
 * retryable; a refusal, an unreadable file or a rejected request is not —
 * retrying those three more times only delays the human who has to look.
 */
export class ExtractionError extends Error {
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message);
    this.name = 'ExtractionError';
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}
