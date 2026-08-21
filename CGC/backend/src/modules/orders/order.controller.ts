import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { OrderImportService, OrderService } from './order.service.js';
import { OrderPdfImportService, type ImportSummary } from './orderPdfImport.service.js';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../db/prisma.js';
import { orderEventEmitter, OrderEvents } from './order.events.js';
import { applyPoReportMerge, parsePoReport, previewPoReportMerge } from './poReportMerge.service.js';
import { SprucePdfError } from '../../lib/pdf/pdfWords.js';
import type { ImportStatus } from '@prisma/client';

export const importOrdersFromCsv = async (req: AuthRequest, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  }

  try {
    const summary = await OrderImportService.importFromCsv(file.buffer, file.originalname);

    return res.status(200).json({
      message: 'Import completed',
      ...summary,
    });
  } catch (err: any) {
    console.error('Order import error', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Unexpected error during import' });
  }
};

/**
 * One at a time: parsing a report is CPU-bound on the event loop that serves
 * the whole app, so two concurrent imports would stall every other request.
 * The upload middleware bounds requests; this bounds the actual work.
 */
let pdfImportRunning = 0;
const pdfImportQueue: Array<() => void> = [];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function acquirePdfImportSlot(): Promise<() => void> {
  if (pdfImportRunning < 1) {
    pdfImportRunning++;
    return () => { pdfImportRunning--; pdfImportQueue.shift()?.(); };
  }
  await new Promise<void>(resolve => pdfImportQueue.push(resolve));
  pdfImportRunning++;
  return () => { pdfImportRunning--; pdfImportQueue.shift()?.(); };
}

/** Maps an import result onto the durable job status. */
function statusForSummary(summary: {
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  skipped: number;
  errors: Array<{ error: string }>;
}): ImportStatus {
  const imported = summary.created + summary.updated + summary.unchanged;
  if (imported === 0 && summary.errors.length > 0) return 'FAILED';
  if (summary.errors.length > 0 || summary.skipped > 0 || summary.conflicts > 0) return 'PARTIAL';
  return 'COMPLETED';
}

/** AP users may recover only their own imports; owners and admins may support any import. */
function importJobAccessWhere(req: AuthRequest, jobId: string) {
  return req.user?.role === 'AP_USER'
    ? { id: jobId, uploadedById: req.user.id }
    : { id: jobId };
}

function terminalSummary(
  job: {
    createdCount: number;
    updatedCount: number;
    unchangedCount: number;
    absentCount: number;
    conflictCount: number;
    skippedCount: number;
  },
  errors: Array<{ rowNumber: number; error: string }>
): ImportSummary {
  return {
    created: job.createdCount,
    updated: job.updatedCount,
    unchanged: job.unchangedCount,
    absent: job.absentCount,
    conflicts: job.conflictCount,
    skipped: job.skippedCount,
    errors,
  };
}

/**
 * Makes row errors and the terminal status visible in one database commit.
 * A reconnect can therefore never observe PARTIAL with an empty error list.
 */
async function persistTerminalImport(jobId: string, summary: ImportSummary): Promise<ImportStatus> {
  const status = statusForSummary(summary);

  await prisma.$transaction(async tx => {
    await tx.spruceImportRowError.deleteMany({ where: { importJobId: jobId } });
    if (summary.errors.length > 0) {
      await tx.spruceImportRowError.createMany({
        data: summary.errors.slice(0, 50).map(error => ({
          importJobId: jobId,
          rowNumber: error.rowNumber,
          rawRowData: '',
          errorMessage: error.error,
        })),
      });
    }

    await tx.spruceImportJob.update({
      where: { id: jobId },
      data: {
        status,
        finishedAt: new Date(),
        totalRows: summary.created + summary.updated + summary.unchanged + summary.skipped,
        createdCount: summary.created,
        updatedCount: summary.updated,
        unchangedCount: summary.unchanged,
        absentCount: summary.absent,
        conflictCount: summary.conflicts,
        skippedCount: summary.skipped,
        errorSummary: summary.errors.slice(0, 3).map(error => error.error).join(' | ') || null,
      },
    });
  });

  return status;
}

export const importOrdersFromPdf = async (req: AuthRequest, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'PDF file is required (field name: file)' });
  }

  const jobId = uuidv4();
  // Make sure to copy the buffer since req.file.buffer might be freed.
  const fileBuffer = Buffer.from(file.buffer);
  const uploadedById = req.user!.id;

  // The job is durable before the 202 leaves: whatever happens to the stream,
  // the browser can ask what became of this upload.
  try {
    await prisma.spruceImportJob.create({
      data: { id: jobId, uploadedById, fileUrl: file.originalname, status: 'PENDING' },
    });
  } catch (err) {
    console.error('Could not record the import job', err);
    return res.status(503).json({
      error: 'The import could not be recorded, so no order data was changed. Please retry.',
    });
  }

  void (async () => {
    const release = await acquirePdfImportSlot();
    try {
      await prisma.spruceImportJob.update({
        where: { id: jobId },
        data: { status: 'PROCESSING' },
      });

      const summary = await OrderPdfImportService.importFromPdf(fileBuffer, jobId);
      const status = await persistTerminalImport(jobId, summary);

      if (status === 'FAILED') {
        orderEventEmitter.emit(OrderEvents.PDF_IMPORT_ERROR, {
          jobId,
          error: summary.errors[0]?.error || 'The import failed.',
          summary,
        });
      } else {
        orderEventEmitter.emit(OrderEvents.PDF_IMPORT_DONE, { jobId, status, summary });
      }
    } catch (err: any) {
      console.error('Background PDF import failed catastrophically', err);
      const publicError =
        'The import failed unexpectedly. Retry the report; if it keeps failing, ' +
        'contact an administrator with the job ID.';
      await prisma.spruceImportJob
        .update({
          where: { id: jobId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorSummary: publicError,
          },
        })
        .catch(() => undefined);
      orderEventEmitter.emit(OrderEvents.PDF_IMPORT_ERROR, {
        jobId,
        error: publicError,
      });
    } finally {
      release();
    }
  })();

  return res.status(202).json({
    message: 'PDF Import started',
    jobId,
  });
};

export const streamPdfImport = async (req: AuthRequest, res: Response) => {
  const { jobId } = req.query;

  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ error: 'jobId is required' });
  }
  if (!UUID_PATTERN.test(jobId)) {
    return res.status(400).json({ error: 'jobId must be a UUID' });
  }

  let initialJob;
  try {
    initialJob = await prisma.spruceImportJob.findFirst({
      where: importJobAccessWhere(req, jobId),
    });
  } catch (err) {
    console.error('Could not authorize the import stream', err);
    return res.status(500).json({ error: 'Could not open the import stream' });
  }
  if (!initialJob) return res.status(404).json({ error: 'No such import job' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // A comment line every so often keeps proxies from closing an idle stream.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    orderEventEmitter.off(OrderEvents.PDF_IMPORT_PROGRESS, onProgress);
    orderEventEmitter.off(OrderEvents.PDF_IMPORT_DONE, onDone);
    orderEventEmitter.off(OrderEvents.PDF_IMPORT_ERROR, onError);
  };

  const onProgress = (data: any) => {
    if (data.jobId === jobId) {
      res.write(`data: ${JSON.stringify({ type: 'progress', ...data })}\n\n`);
    }
  };

  let finished = false;
  const finishWith = (payload: Record<string, unknown>) => {
    if (finished) return;
    finished = true;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    cleanup();
    res.end();
  };

  const onDone = (data: any) => {
    if (data.jobId === jobId) finishWith({ type: 'done', ...data });
  };

  const onError = (data: any) => {
    if (data.jobId === jobId) finishWith({ type: 'error', ...data });
  };

  orderEventEmitter.on(OrderEvents.PDF_IMPORT_PROGRESS, onProgress);
  orderEventEmitter.on(OrderEvents.PDF_IMPORT_DONE, onDone);
  orderEventEmitter.on(OrderEvents.PDF_IMPORT_ERROR, onError);

  req.on('close', cleanup);

  // Parsing the text layer is fast enough to finish before a client attaches,
  // and events sent before then are gone — so the durable job is replayed
  // first. A finished import reports its stored result immediately instead of
  // leaving the stream open forever.
  try {
    const job = await prisma.spruceImportJob.findFirst({
      where: importJobAccessWhere(req, jobId),
      include: { rowErrors: { orderBy: { rowNumber: 'asc' } } },
    });
    if (job && ['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.status)) {
      const errors = job.rowErrors.map(error => ({
        rowNumber: error.rowNumber,
        error: error.errorMessage,
      }));
      const summary = terminalSummary(job, errors);
      finishWith({
        type: job.status === 'FAILED' ? 'error' : 'done',
        jobId,
        status: job.status,
        ...(job.status === 'FAILED'
          ? { error: job.errorSummary || 'The import failed.', summary }
          : { summary }),
      });
      return;
    }
  } catch (err) {
    console.error('Could not replay the import job', err);
  }

  orderEventEmitter.emit(OrderEvents.PDF_IMPORT_ATTACHED, { jobId });
};

/** Polls a durable import job — for reconnects and for streams that died. */
export const getPdfImportJob = async (req: AuthRequest, res: Response) => {
  const jobId = req.params.jobId ? String(req.params.jobId) : '';
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (!UUID_PATTERN.test(jobId)) return res.status(400).json({ error: 'jobId must be a UUID' });

  try {
    const job = await prisma.spruceImportJob.findFirst({
      where: importJobAccessWhere(req, jobId),
    });
    if (!job) return res.status(404).json({ error: 'No such import job' });

    const rowErrors = await prisma.spruceImportRowError.findMany({
      where: { importJobId: job.id },
      orderBy: { rowNumber: 'asc' },
    });

    return res.status(200).json({
      jobId: job.id,
      fileName: job.fileUrl,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      counts: {
        total: job.totalRows,
        created: job.createdCount,
        updated: job.updatedCount,
        unchanged: job.unchangedCount,
        absent: job.absentCount,
        conflicts: job.conflictCount,
        skipped: job.skippedCount,
      },
      errorSummary: job.errorSummary,
      errors: rowErrors.map(e => ({ rowNumber: e.rowNumber, error: e.errorMessage })),
    });
  } catch (err: any) {
    console.error('Error fetching import job', err);
    return res.status(500).json({ error: err?.message || 'Unexpected error fetching import job' });
  }
};

export const getOrders = async (req: AuthRequest, res: Response) => {
  try {
    const orders = await OrderService.getOrders(req.query);
    return res.status(200).json(orders);
  } catch (err: any) {
    // A rejected filter is the caller's problem, not a server fault. Reporting
    // it as a 500 hid the one case that matters: an unparseable date must fail
    // loudly rather than fall through to an unfiltered query.
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error('Error fetching orders', err);
    return res
      .status(status)
      .json({ error: err?.message || 'Unexpected error fetching orders' });
  }
};
/**
 * Second step of the Spruce two-report import: the PO report.
 *
 * Preview by default. The PO number decides which invoice lines match which
 * orders, so a merge is shown before it is written rather than after.
 * `?apply=true` performs it; `?overwriteConflicts=true` additionally replaces
 * PO numbers that are already set to something else.
 */
export const mergePoReport = async (req: AuthRequest, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'PO report PDF is required (field name: file)' });
  }

  try {
    const { rows, lines, unreadable } = await parsePoReport(file.buffer);

    if (req.query.apply !== 'true') {
      const preview = await previewPoReportMerge(rows, unreadable, lines);
      return res.status(200).json({ applied: false, ...preview });
    }

    const summary = await applyPoReportMerge(rows, lines, {
      overwriteConflicts: req.query.overwriteConflicts === 'true',
    });

    return res.status(200).json({ applied: true, ...summary, unreadable });
  } catch (err: any) {
    console.error('PO report merge error', err);

    // A SprucePdfError is about the file the user chose — the wrong report, or
    // a scan of one — so it is theirs to correct, and its message says how.
    if (err instanceof SprucePdfError) {
      return res.status(400).json({ error: err.message });
    }

    return res.status(500).json({ error: err?.message || 'Unexpected error merging PO report' });
  }
};
