import type { Response } from 'express';

import { prisma } from '../../../db/prisma.js';
import { businessDayOf } from '../../../lib/businessDay.js';
import { SprucePdfError } from '../../../lib/pdf/pdfWords.js';
import { parseSpruceDate } from '../../../lib/spruceDate.js';
import type { AuthRequest } from '../../../middleware/authMiddleware.js';
import { parseSprucePdf } from '../spruce/parseSprucePdf.js';
import type { ParsedSpruceReport, SpruceReportType } from '../spruce/spruceReportTypes.js';
import { ImportBatchError, SLOT_LABELS, runImportBatch, type BatchFile } from './importBatch.service.js';

/** The three upload slots, in the order the screen shows them. */
export const REPORT_SLOTS: SpruceReportType[] = ['ORDER_SUMMARY', 'DELIVERY', 'ITEM_TRACKING'];

const isoOrNull = (raw: string | undefined) => parseSpruceDate(raw)?.toISOString().slice(0, 10) ?? null;

function describe(report: ParsedSpruceReport) {
  return {
    reportType: report.type,
    label: SLOT_LABELS[report.type],
    pageCount: report.pageCount ?? null,
    documentCount: new Set(report.rows.map(row => row.documentNumber)).size,
    rowCount: report.rows.length,
    unreadableCount: report.unreadable.length,
    dateFrom: isoOrNull(report.dateRange?.fromRaw),
    dateTo: isoOrNull(report.dateRange?.toRaw),
  };
}

/**
 * Reads one report as it is dropped into a slot, writing nothing.
 *
 * The screen shows what it found — which report, which dates, how many
 * orders — so a wrong file is noticed before anything is imported.
 */
export const previewSpruceReport = async (req: AuthRequest, res: Response) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'A PDF is required (field name: file).' });

  try {
    return res.json(describe(await parseSprucePdf(file.buffer)));
  } catch (err) {
    if (err instanceof SprucePdfError) return res.status(422).json({ error: err.message, code: err.code });
    console.error('[SpruceImport] Preview failed', err);
    return res.status(500).json({ error: 'The report could not be read. Retry; if it keeps failing, export it again.' });
  }
};

/**
 * Imports the morning's reports together and returns what the day looks like.
 *
 * Every file is read and checked against its slot before anything is written,
 * so a report in the wrong slot changes nothing.
 */
export const importSpruceReports = async (req: AuthRequest, res: Response) => {
  const byField = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const files: BatchFile[] = [];

  for (const slot of REPORT_SLOTS) {
    const file = byField[slot]?.[0];
    if (!file) continue;

    let report: ParsedSpruceReport;
    try {
      report = await parseSprucePdf(file.buffer);
    } catch (err) {
      if (err instanceof SprucePdfError) {
        return res.status(422).json({ error: `${SLOT_LABELS[slot]}: ${err.message}`, slot });
      }
      console.error('[SpruceImport] Could not read a report', err);
      return res.status(500).json({ error: `${SLOT_LABELS[slot]} could not be read. Retry the upload.`, slot });
    }

    if (report.type !== slot) {
      return res.status(422).json({
        error: `${file.originalname} looks like the ${SLOT_LABELS[report.type]}, not the ${SLOT_LABELS[slot]}.`,
        slot,
        detectedType: report.type,
      });
    }
    files.push({ reportType: slot, fileName: file.originalname, buffer: file.buffer, report });
  }

  const dispatchDate = typeof req.body?.dispatchDate === 'string' && req.body.dispatchDate
    ? req.body.dispatchDate
    : businessDayOf();

  try {
    const summary = await runImportBatch(prisma, { dispatchDate, createdById: req.user!.id, files });
    return res.json(summary);
  } catch (err) {
    if (err instanceof ImportBatchError) return res.status(400).json({ error: err.message });
    console.error('[SpruceImport] Import failed', err);
    return res.status(500).json({
      error: 'The import failed unexpectedly. Nothing already imported was lost; retry the upload.',
    });
  }
};
