import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseSprucePdf } from '../modules/orders/spruce/parseSprucePdf.js';
import type {
  ParsedSpruceReport,
  ParsedSpruceRow,
} from '../modules/orders/spruce/spruceReportTypes.js';

const REPORT_FIELDS = [
  'documentNumber',
  'customerName',
  'product',
  'itemNumber',
  'quantity',
  'unit',
  'orderDateRaw',
  'deliveryDateRaw',
  'poNumber',
  'vendorName',
  'shippingAddress',
  'orderNotes',
] as const satisfies readonly (keyof ParsedSpruceRow)[];

type ReportField = (typeof REPORT_FIELDS)[number];

export interface SpruceDryRunSummary {
  type: ParsedSpruceReport['type'];
  rowCount: number;
  unreadableCount: number;
  documentNumbers: string[];
  fillRates: Array<{
    field: ReportField;
    filled: number;
    total: number;
    percent: number;
  }>;
}

function isFilled(value: unknown): boolean {
  return typeof value === 'string'
    ? value.trim().length > 0
    : value !== null && value !== undefined;
}

export function summariseSpruceReport(report: ParsedSpruceReport): SpruceDryRunSummary {
  const total = report.rows.length;

  return {
    type: report.type,
    rowCount: total,
    unreadableCount: report.unreadable.length,
    documentNumbers: [...new Set(report.rows.map(row => row.documentNumber))].sort(),
    fillRates: REPORT_FIELDS.map(field => {
      const filled = report.rows.filter(row => isFilled(row[field])).length;
      return {
        field,
        filled,
        total,
        percent: total === 0 ? 0 : (filled / total) * 100,
      };
    }),
  };
}

export function formatSpruceDryRun(summary: SpruceDryRunSummary): string {
  const documents = summary.documentNumbers.length > 0
    ? summary.documentNumbers.join(', ')
    : '(none)';
  const fillRates = summary.fillRates.map(rate =>
    `  ${rate.field}: ${rate.filled}/${rate.total} (${rate.percent.toFixed(1)}%)`
  );

  return [
    `Detected type: ${summary.type}`,
    `Rows: ${summary.rowCount}`,
    `Unreadable: ${summary.unreadableCount}`,
    `Distinct documents: ${summary.documentNumbers.length}`,
    `Document numbers: ${documents}`,
    'Field fill rates:',
    ...fillRates,
  ].join('\n');
}

async function main(): Promise<void> {
  const [filePath, ...extra] = process.argv.slice(2);
  if (!filePath || extra.length > 0) {
    throw new Error('Usage: npm run spruce:dryrun -- <file.pdf>');
  }

  const report = await parseSprucePdf(await readFile(filePath));
  console.log(formatSpruceDryRun(summariseSpruceReport(report)));
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
