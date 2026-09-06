import fs from 'node:fs';
import path from 'node:path';
import {
  activeProvider,
  extractInvoice,
  extractTicket,
  mimeTypeForFilename,
} from '../services/extraction/extraction.service.js';

/**
 * Scores the extraction provider against documents whose true values a person
 * has checked by hand.
 *
 * This exists because "the cheap model seemed fine" is not a decision anybody
 * can act on later. Extraction is the foundation the pay-only-for-what-arrived
 * chain rests on, and the honest way to choose a model is to measure it on real
 * paperwork — creased ticket photos, multi-page invoices — and write the
 * numbers down.
 *
 * The bar, from the optimisation plan:
 *   - poNumber and quantity: at least 95% exact
 *   - every other field:      at least 85% exact
 *   - no hallucinations on documents marked unreadable
 *
 * Below the bar, raise OPENAI_MODEL_ID one step and run this again. The script
 * scores whatever the service is configured to use, so the same numbers compare
 * every candidate.
 *
 * THE GOLDEN SET NEVER ENTERS GIT. It is real client paperwork. Keep it in the
 * directory named by EXTRACTION_EVAL_DIR (default `.extraction-eval/`, which is
 * gitignored), or in a private Supabase bucket you copy down before a run.
 *
 * Usage:
 *   EXTRACTION_EVAL_DIR=../golden npx tsx src/scripts/extractionEval.ts
 *
 * The directory holds the documents plus a `manifest.json`:
 *   [
 *     { "file": "ticket-01.jpg", "kind": "ticket",
 *       "expected": { "poNumber": "123456", "quantity": 24.6, "unit": "tonnes",
 *                     "supplierName": "Dufferin Aggregates",
 *                     "ticketDate": "2026-08-13", "ticketNumber": "T-88213" } },
 *     { "file": "invoice-04.pdf", "kind": "invoice", "unreadable": true,
 *       "expected": { "poNumber": null, "invoiceNumber": "INV-5512" } }
 *   ]
 *
 * Only the fields you list are scored, so a document whose date is genuinely
 * illegible can simply omit `ticketDate` rather than being excluded.
 */

/** Fields the verification chain cannot work without. Held to the higher bar. */
const CRITICAL_FIELDS = new Set(['poNumber', 'quantity']);

const CRITICAL_BAR = 0.95;
const OTHER_BAR = 0.85;

interface GoldenCase {
  file: string;
  kind: 'ticket' | 'invoice';
  /** True when the document is barely legible: it must not be answered confidently. */
  unreadable?: boolean;
  expected: Record<string, unknown>;
}

interface FieldOutcome {
  document: string;
  field: string;
  expected: unknown;
  actual: unknown;
  correct: boolean;
  /** A value invented where the document had none. */
  hallucinated: boolean;
}

function loadManifest(directory: string): GoldenCase[] {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No manifest.json in ${directory}. Point EXTRACTION_EVAL_DIR at the golden set, ` +
        `and remember it must live outside the repository.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('manifest.json must contain an array of cases');
  return parsed as GoldenCase[];
}

/**
 * Compares a read value with the checked one.
 *
 * Numbers are compared with a small tolerance so 24.60 matches 24.6; text is
 * compared case- and space-insensitively so "DUFFERIN AGGREGATES" matches
 * "Dufferin Aggregates". Dates are compared as `YYYY-MM-DD`. Anything looser
 * than this would flatter the model.
 */
function valuesMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;

  if (typeof expected === 'number') {
    const actualNumber = typeof actual === 'number' ? actual : Number(actual);
    return Number.isFinite(actualNumber) && Math.abs(expected - actualNumber) < 0.005;
  }

  const actualText = actual instanceof Date ? actual.toISOString().slice(0, 10) : String(actual);
  return (
    String(expected).trim().toLowerCase().replace(/\s+/g, ' ') ===
    actualText.trim().toLowerCase().replace(/\s+/g, ' ')
  );
}

function scoreCase(
  testCase: GoldenCase,
  extracted: Record<string, unknown>
): FieldOutcome[] {
  return Object.entries(testCase.expected).map(([field, expected]) => {
    const actual = extracted[field] ?? null;
    const correct = valuesMatch(expected, actual);
    return {
      document: testCase.file,
      field,
      expected,
      actual,
      correct,
      // The failure that matters most: the document did not say, and the model
      // answered anyway. A null costs someone a minute; an invented PO number
      // attaches a delivery to the wrong order.
      hallucinated: (expected === null || expected === undefined) && actual !== null,
    };
  });
}

function percent(correct: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`;
}

async function main(): Promise<void> {
  const directory = path.resolve(process.env.EXTRACTION_EVAL_DIR || '.extraction-eval');
  const cases = loadManifest(directory);
  const { name, modelId } = activeProvider();

  console.log(`\nExtraction eval — provider ${name}, model ${modelId}`);
  console.log(`Golden set: ${cases.length} documents from ${directory}\n`);

  const outcomes: FieldOutcome[] = [];
  const failures: string[] = [];

  for (const testCase of cases) {
    const filePath = path.join(directory, testCase.file);
    if (!fs.existsSync(filePath)) {
      failures.push(`${testCase.file}: not found`);
      continue;
    }

    try {
      const bytes = fs.readFileSync(filePath);
      const mimeType = mimeTypeForFilename(testCase.file);
      const extracted =
        testCase.kind === 'invoice'
          ? await extractInvoice(bytes, mimeType, testCase.file)
          : await extractTicket(bytes, mimeType, testCase.file);

      outcomes.push(...scoreCase(testCase, extracted as unknown as Record<string, unknown>));
    } catch (error) {
      // A document the pipeline cannot read at all is a result, not a crash:
      // it would reach the stuck-jobs list in production too.
      failures.push(`${testCase.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const critical = outcomes.filter((o) => CRITICAL_FIELDS.has(o.field));
  const other = outcomes.filter((o) => !CRITICAL_FIELDS.has(o.field));
  const criticalCorrect = critical.filter((o) => o.correct).length;
  const otherCorrect = other.filter((o) => o.correct).length;
  const hallucinations = outcomes.filter((o) => o.hallucinated);

  const criticalRate = critical.length === 0 ? 1 : criticalCorrect / critical.length;
  const otherRate = other.length === 0 ? 1 : otherCorrect / other.length;

  console.log('Accuracy');
  console.log(`  poNumber + quantity : ${percent(criticalCorrect, critical.length)}  (bar ${CRITICAL_BAR * 100}%)`);
  console.log(`  other fields        : ${percent(otherCorrect, other.length)}  (bar ${OTHER_BAR * 100}%)`);
  console.log(`  invented values     : ${hallucinations.length}  (bar 0)`);

  const wrong = outcomes.filter((o) => !o.correct);
  if (wrong.length > 0) {
    console.log('\nMisreadings');
    for (const outcome of wrong) {
      const note = outcome.hallucinated ? '  <- invented' : '';
      console.log(
        `  ${outcome.document} ${outcome.field}: expected ${JSON.stringify(outcome.expected)}, read ${JSON.stringify(outcome.actual)}${note}`
      );
    }
  }

  if (failures.length > 0) {
    console.log('\nDocuments that could not be processed');
    for (const failure of failures) console.log(`  ${failure}`);
  }

  const passed =
    criticalRate >= CRITICAL_BAR &&
    otherRate >= OTHER_BAR &&
    hallucinations.length === 0 &&
    failures.length === 0;

  console.log(
    `\nVerdict: ${passed ? 'PASS' : 'BELOW BAR'} for ${modelId}. ` +
      `Put these numbers in the PR body${passed ? '.' : ', then try the next model up.'}\n`
  );

  // Non-zero on failure so this can gate a pipeline later without rewriting.
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error('[extraction-eval]', error);
  process.exit(1);
});
