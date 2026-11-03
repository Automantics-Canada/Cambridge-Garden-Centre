/**
 * The files a sample dry run reads: the samples themselves, the optional
 * hand-written manifest.json, the optional related.json of orders, tickets
 * and rates, and the pre-extracted `<file>.extraction.json` that lets a run
 * work offline.
 *
 * The samples are real client paperwork. They live in a gitignored folder
 * (CGC/backend/.samples/ by default) and the report is written beside them,
 * so this module also refuses to write a report into a folder git would
 * commit.
 */
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const MANIFEST_FILE = 'manifest.json';
export const RELATED_FILE = 'related.json';
export const REPORT_FILE = 'dry-run-report.json';
export const EXTRACTION_SUFFIX = '.extraction.json';

/** What a sample file is taken to be from its name, before its bytes are looked at. */
export const SAMPLE_EXTENSIONS: Record<string, 'pdf' | 'image' | 'spreadsheet'> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  heic: 'image',
  heif: 'image',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  xls: 'spreadsheet',
  csv: 'spreadsheet',
};

export const SampleManifestSchema = z.object({
  notes: z.string().optional(),
  samples: z
    .array(
      z.object({
        file: z.string().min(1),
        /** The supplier as CGC knows it, e.g. the name on the Rates page. */
        supplier: z.string().optional(),
        supplierType: z.enum(['SUPPLIER', 'TRUCKING_COMPANY']).optional(),
        /** Spruce document numbers of the orders this invoice bills. */
        spruceOrderNumbers: z.array(z.string()).optional(),
        poNumbers: z.array(z.string()).optional(),
        invoiceNumber: z.string().optional(),
        expectedTotal: z.number().optional(),
        /** Already paid in CGC's books: never to be entered anywhere. */
        alreadyPaid: z.boolean().optional(),
        notes: z.string().optional(),
      })
    )
    .default([]),
});
export type SampleManifest = z.output<typeof SampleManifestSchema>;
export type ManifestEntry = SampleManifest['samples'][number];

/**
 * A pre-extracted reading: what the model replied for this file, saved by a
 * live run with --save-extractions or written by hand. Keys of `tickets` are
 * page numbers ("1" for a file that is one ticket).
 *
 * Loose on purpose: a reply saved before the reader gained a field (a line's
 * ticket number, say) must still load. Missing fields are filled the way the
 * reader would have returned them, as null.
 */
const nullableString = z.string().nullable().default(null);
const nullableNumber = z.number().nullable().default(null);

export const FixtureInvoiceSchema = z.looseObject({
  supplierName: nullableString,
  invoiceNumber: nullableString,
  date: nullableString,
  poNumber: nullableString,
  totalAmount: nullableNumber,
  lineItems: z
    .array(
      z.looseObject({
        description: z.string().default(''),
        quantity: nullableNumber,
        unit: nullableString,
        unitPrice: nullableNumber,
        totalPrice: nullableNumber,
        poNumber: nullableString,
      })
    )
    .default([]),
  readability: z.enum(['clear', 'partly_legible', 'poor']).default('clear'),
  uncertainFields: z.array(z.string()).default([]),
});

export const FixtureTicketSchema = z.looseObject({
  supplierName: nullableString,
  date: nullableString,
  ticketNumber: nullableString,
  poNumber: nullableString,
  material: nullableString,
  quantity: nullableNumber,
  unit: nullableString,
  readability: z.enum(['clear', 'partly_legible', 'poor']).default('clear'),
  uncertainFields: z.array(z.string()).default([]),
});

export const ExtractionFixtureSchema = z.object({
  triage: z
    .object({
      pages: z.array(
        z.object({
          page: z.number(),
          kind: z.enum(['invoice', 'delivery_ticket', 'statement', 'credit_memo', 'other']),
        })
      ),
    })
    .nullable()
    .optional(),
  invoice: FixtureInvoiceSchema.nullable().optional(),
  tickets: z.record(z.string(), FixtureTicketSchema).optional(),
});
export type ExtractionFixture = z.output<typeof ExtractionFixtureSchema>;

/** Files in the folder that are not samples: our own inputs and outputs, and hidden files. */
export function isSampleFile(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (name === MANIFEST_FILE || name === RELATED_FILE || name === REPORT_FILE) return false;
  if (name.endsWith(EXTRACTION_SUFFIX) || name.endsWith('.example.json')) return false;
  if (/\.(md|txt)$/i.test(name)) return false;
  return true;
}

/** The sample files in a folder, sorted, not descending into subfolders. */
export async function listSampleFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isSampleFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function extractionFixturePath(dir: string, file: string): string {
  return path.join(dir, `${file}${EXTRACTION_SUFFIX}`);
}

export type IgnoreState = 'ignored' | 'tracked-or-committable' | 'outside-git';

/**
 * Whether git would leave this path alone.
 *
 * `git check-ignore` exits 0 for an ignored path, 1 for one it would add,
 * and 128 outside a repository. A report of real paperwork must never land
 * somewhere `git add` would pick it up.
 */
export function gitIgnoreState(target: string): IgnoreState {
  const result = spawnSync('git', ['check-ignore', '-q', path.basename(target)], {
    cwd: path.dirname(target),
    stdio: 'ignore',
  });
  if (result.status === 0) return 'ignored';
  if (result.status === 1) return 'tracked-or-committable';
  return 'outside-git';
}
