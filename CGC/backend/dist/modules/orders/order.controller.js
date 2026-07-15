import { OrderImportService, OrderService } from './order.service.js';
import { OrderPdfImportService } from './orderPdfImport.service.js';
import { v4 as uuidv4 } from 'uuid';
import { orderEventEmitter, OrderEvents } from './order.events.js';
export const importOrdersFromCsv = async (req, res) => {
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
    }
    catch (err) {
        console.error('Order import error', err);
        return res
            .status(500)
            .json({ error: err?.message || 'Unexpected error during import' });
    }
};
export const importOrdersFromPdf = async (req, res) => {
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
export const streamPdfImport = async (req, res) => {
    const { jobId } = req.query;
    if (!jobId || typeof jobId !== 'string') {
        return res.status(400).json({ error: 'jobId is required' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const onProgress = (data) => {
        if (data.jobId === jobId) {
            res.write(`data: ${JSON.stringify({ type: 'progress', ...data })}\n\n`);
        }
    };
    const onDone = (data) => {
        if (data.jobId === jobId) {
            res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`);
            cleanup();
            res.end();
        }
    };
    const onError = (data) => {
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
export const getOrders = async (req, res) => {
    try {
        const orders = await OrderService.getOrders(req.query);
        return res.status(200).json(orders);
    }
    catch (err) {
        console.error('Error fetching orders', err);
        return res
            .status(500)
            .json({ error: err?.message || 'Unexpected error fetching orders' });
    }
};
//# sourceMappingURL=order.controller.js.map