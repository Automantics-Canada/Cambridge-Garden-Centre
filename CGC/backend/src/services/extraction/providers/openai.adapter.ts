import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { env } from '../../../config/env.js';
import { ExtractionError, type ExtractionDocument, type ExtractionProvider } from './types.js';

/**
 * Reads documents with an OpenAI vision model.
 *
 * Two things about this are load-bearing:
 *
 * 1. It uses the **Responses API**, which accepts a PDF as a file part and
 *    reads both its text and its page images. The pipeline this replaced could
 *    only send an image, so every PDF was first rasterised to a PNG at 3x scale
 *    — CPU-bound work heavy enough that it had to be pushed off the request
 *    loop into a worker. Invoices now go to the model as PDFs, and only the
 *    first page of a multi-page invoice is no longer all we see.
 * 2. The reply is validated against a Zod schema by the API itself
 *    (structured outputs), so this adapter never parses prose. Either the
 *    response fits the schema or the job fails.
 */

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const PDF_MIME_TYPE = 'application/pdf';

/**
 * Generous enough for a long invoice's line items; far below the model's
 * ceiling. A response cut off by this limit is reported, never truncated
 * silently into a short list of lines that looks complete.
 */
const MAX_OUTPUT_TOKENS = 16_000;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  // Constructed on first use rather than at import: the API key is validated in
  // config/env.ts, and building the client at module load would make every test
  // that merely imports this file require a key.
  if (!client) {
    client = new OpenAI({ apiKey: env.openaiApiKey, maxRetries: 0 });
  }
  return client;
}

/** How the document is attached to the request, by type. */
function toContentPart(document: ExtractionDocument) {
  const base64 = document.bytes.toString('base64');
  const mimeType = document.mimeType.toLowerCase();

  if (mimeType === PDF_MIME_TYPE) {
    return {
      type: 'input_file' as const,
      filename: document.filename,
      file_data: `data:${PDF_MIME_TYPE};base64,${base64}`,
    };
  }

  if (IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      type: 'input_image' as const,
      image_url: `data:${mimeType};base64,${base64}`,
      detail: 'auto' as const,
    };
  }

  // Reached only if an upload validator let something else through. Permanent:
  // the same bytes will be just as unreadable on a retry.
  throw new ExtractionError(`Cannot read a document of type "${document.mimeType}"`, {
    retryable: false,
  });
}

/**
 * Sorts a provider failure into "try again later" or "a person needs to look".
 *
 * Rate limits and upstream faults are transient. A rejected request, a refusal
 * or a bad key will fail identically on all four attempts, so those stop
 * immediately and surface on the stuck-jobs list instead of three retries later.
 */
function toExtractionError(error: unknown): ExtractionError {
  if (error instanceof ExtractionError) return error;

  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    return new ExtractionError(
      `OpenAI request failed (${status || 'no status'}): ${error.message}`,
      { retryable, cause: error }
    );
  }

  // Connection resets, DNS failures, timeouts: worth another attempt.
  return new ExtractionError(
    `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
    { retryable: true, cause: error }
  );
}

export const openaiExtractionProvider: ExtractionProvider = {
  name: 'openai',
  get modelId() {
    return env.openaiModelId;
  },

  async extract<T>(
    document: ExtractionDocument,
    prompt: string,
    schema: z.ZodType<T>,
    schemaName: string
  ): Promise<T> {
    const documentPart = toContentPart(document);

    let response;
    try {
      response = await getClient().responses.parse({
        model: env.openaiModelId,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: prompt }, documentPart],
          },
        ],
        text: { format: zodTextFormat(schema, schemaName) },
      });
    } catch (error) {
      throw toExtractionError(error);
    }

    // A refusal is the model declining to answer at all. It will decline again,
    // so this does not retry.
    const refusal = response.output
      ?.flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((part) => part.type === 'refusal');
    if (refusal && refusal.type === 'refusal') {
      throw new ExtractionError(`Model refused to read the document: ${refusal.refusal}`, {
        retryable: false,
      });
    }

    if (response.status === 'incomplete') {
      // Almost always max_output_tokens on a very long invoice. Retrying sends
      // the identical request into the identical limit, so a person is told.
      throw new ExtractionError(
        `Model response was cut short (${response.incomplete_details?.reason ?? 'unknown reason'})`,
        { retryable: false }
      );
    }

    const parsed = response.output_parsed;
    if (parsed === null || parsed === undefined) {
      // Schema validation failed upstream. Transient often enough to be worth
      // one more attempt, and the retry cap stops it becoming a loop.
      throw new ExtractionError('Model returned no value matching the expected schema', {
        retryable: true,
      });
    }

    return parsed as T;
  },
};
