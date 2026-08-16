import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { OrderImportService, OrderService } from './order.service.js';
import { OrderPdfImportService } from './orderPdfImport.service.js';
import { v4 as uuidv4 } from 'uuid';
import { orderEventEmitter, OrderEvents } from './order.events.js';
import { applyPoReportMerge, parsePoReport, previewPoReportMerge } from './poReportMerge.service.js';
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

export const importOrdersFromPdf = async (req: AuthRequest, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'PDF file is required (field name: file)' });
  }

  const jobId = uuidv4();

  // Start processing in the background (fire and forget)
  // Make sure to copy the buffer since req.file.buffer might be freed
  const fileBuffer = Buffer.from(file.buffer);
  
  OrderPdfImportService.importFromPdf(fileBuffer, jobId).catch(err => {
    console.error('Background PDF import failed catastrophically', err);
  });

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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onProgress = (data: any) => {
    if (data.jobId === jobId) {
      res.write(`data: ${JSON.stringify({ type: 'progress', ...data })}\n\n`);
    }
  };

  const onDone = (data: any) => {
    if (data.jobId === jobId) {
      res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`);
      cleanup();
      res.end();
    }
  };

  const onError = (data: any) => {
    if (data.jobId === jobId) {
      res.write(`data: ${JSON.stringify({ type: 'error', ...data })}\n\n`);
      cleanup();
      res.end();
    }
  };

  orderEventEmitter.on(OrderEvents.PDF_IMPORT_PROGRESS, onProgress);
  orderEventEmitter.on(OrderEvents.PDF_IMPORT_DONE, onDone);
  orderEventEmitter.on(OrderEvents.PDF_IMPORT_ERROR, onError);

  const cleanup = () => {
    orderEventEmitter.off(OrderEvents.PDF_IMPORT_PROGRESS, onProgress);
    orderEventEmitter.off(OrderEvents.PDF_IMPORT_DONE, onDone);
    orderEventEmitter.off(OrderEvents.PDF_IMPORT_ERROR, onError);
  };

  req.on('close', cleanup);
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
    const { rows, unreadable } = await parsePoReport(file.buffer);

    if (req.query.apply !== 'true') {
      const preview = await previewPoReportMerge(rows, unreadable);
      return res.status(200).json({ applied: false, ...preview });
    }

    const summary = await applyPoReportMerge(rows, {
      overwriteConflicts: req.query.overwriteConflicts === 'true',
    });

    return res.status(200).json({ applied: true, ...summary, unreadable });
  } catch (err: any) {
    console.error('PO report merge error', err);
    return res.status(500).json({ error: err?.message || 'Unexpected error merging PO report' });
  }
};
