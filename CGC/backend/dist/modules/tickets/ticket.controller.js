import { TicketService } from './ticket.service.js';
import { processPendingOcrJobs } from '../../services/ocrJobProcessor.js';
import { PDFDocument } from 'pdf-lib';
import { pdfToPng } from 'pdf-to-png-converter';
import path from 'node:path';
import fs from 'node:fs';
export const ingestWhatsappTicket = async (req, res) => {
    const file = req.file;
    const { fromPhone } = req.body;
    if (!file) {
        return res.status(400).json({ error: 'file is required' });
    }
    if (!fromPhone) {
        return res.status(400).json({ error: 'fromPhone is required' });
    }
    try {
        const { ticket, ocrJob } = await TicketService.ingestWhatsappTicket({
            buffer: file.buffer,
            originalName: file.originalname,
            fromPhone,
        });
        return res.status(201).json({
            message: 'WhatsApp ticket received and queued for OCR',
            ticket,
            ocrJobId: ocrJob.id,
        });
    }
    catch (error) {
        console.error('ingestWhatsappTicket error', error);
        return res
            .status(500)
            .json({ error: error?.message ?? 'Unexpected error' });
    }
};
/**
 * Simulated email webhook:
 * multipart/form-data:
 *  - file: ticket image
 *  - fromEmail: sender email (e.g. "tickets@galtgravel.com")
 */
export const ingestEmailTicket = async (req, res) => {
    const file = req.file;
    const { fromEmail } = req.body;
    if (!file) {
        return res.status(400).json({ error: 'file is required' });
    }
    if (!fromEmail) {
        return res.status(400).json({ error: 'fromEmail is required' });
    }
    try {
        const { ticket, ocrJob } = await TicketService.ingestEmailTicket({
            buffer: file.buffer,
            originalName: file.originalname,
            fromEmail,
        });
        return res.status(201).json({
            message: 'Email ticket received and queued for OCR',
            ticket,
            ocrJobId: ocrJob.id,
        });
    }
    catch (error) {
        console.error('ingestEmailTicket error', error);
        return res
            .status(500)
            .json({ error: error?.message ?? 'Unexpected error' });
    }
};
/**
 * Manual ticket upload by admin:
 * multipart/form-data:
 *  - file: ticket image (JPG/PNG)
 */
export const uploadManualTicket = async (req, res) => {
    const file = req.file;
    if (!file) {
        return res.status(400).json({ error: 'file is required' });
    }
    try {
        const { ticket, ocrJob } = await TicketService.ingestManualTicket({
            buffer: file.buffer,
            originalName: file.originalname,
        });
        return res.status(201).json({
            message: 'Ticket uploaded manually and queued for OCR',
            ticket,
            ocrJobId: ocrJob.id,
        });
    }
    catch (error) {
        console.error('uploadManualTicket error', error);
        return res
            .status(500)
            .json({ error: error?.message ?? 'Unexpected error' });
    }
};
/**
 * Manual multi-ticket PDF upload by admin:
 * 1. Splits the PDF into individual pages
 * 2. Converts each page to a PNG buffer
 * 3. Ingests each page individually as a separate ticket
 */
export const uploadManualPdfTickets = async (req, res) => {
    const file = req.file;
    console.log('[UploadPDF] Received request. File details:', {
        exists: !!file,
        originalname: file?.originalname,
        mimetype: file?.mimetype,
        size: file?.size,
        bufferExists: !!file?.buffer,
        bufferLength: file?.buffer?.length,
        bufferType: file?.buffer ? typeof file.buffer : 'undefined',
    });
    if (!file) {
        return res.status(400).json({ error: 'file is required' });
    }
    try {
        console.log(`[UploadPDF] Parsing PDF file: ${file.originalname}`);
        const pdfDoc = await PDFDocument.load(file.buffer);
        const pageCount = pdfDoc.getPageCount();
        console.log(`[UploadPDF] Found ${pageCount} pages in PDF`);
        if (pageCount === 0) {
            return res.status(400).json({ error: 'PDF file is empty' });
        }
        const createdTickets = [];
        const createdOcrJobs = [];
        for (let i = 0; i < pageCount; i++) {
            const pageNum = i + 1;
            console.log(`[UploadPDF] Rendering page ${pageNum}/${pageCount} directly to PNG`);
            let pngBuffer;
            try {
                const pngPages = await pdfToPng(file.buffer, {
                    viewportScale: 2.0,
                    pagesToProcess: [pageNum],
                    disableFontFace: false,
                    useSystemFonts: true,
                    enableXfa: true,
                });
                if (!pngPages || pngPages.length === 0 || !pngPages[0]?.content) {
                    throw new Error(`No content rendered for page ${pageNum}`);
                }
                pngBuffer = pngPages[0].content;
            }
            catch (err) {
                console.error(`[UploadPDF] Direct render failed for page ${pageNum}:`, err.message);
                throw new Error(`Failed to render page ${pageNum} to image: ${err.message}`);
            }
            const baseName = file.originalname.substring(0, file.originalname.lastIndexOf('.')) || file.originalname;
            const pageName = `${baseName}-page-${pageNum}.png`;
            // 3. Ingest Individually: save record and trigger independent OCR job
            const { ticket, ocrJob } = await TicketService.ingestManualTicket({
                buffer: pngBuffer,
                originalName: pageName,
            });
            createdTickets.push(ticket);
            createdOcrJobs.push(ocrJob);
        }
        return res.status(201).json({
            message: `Successfully split PDF and queued ${pageCount} tickets for OCR`,
            tickets: createdTickets,
            ocrJobIds: createdOcrJobs.map(job => job.id),
        });
    }
    catch (error) {
        console.error('uploadManualPdfTickets error', error);
        try {
            const logFile = path.join(process.cwd(), 'debug_upload.log');
            fs.writeFileSync(logFile, `Error: ${error?.message}\nStack: ${error?.stack}\n`);
        }
        catch (logErr) {
            console.error('Failed to write debug log:', logErr);
        }
        return res
            .status(500)
            .json({ error: error?.message ?? 'Unexpected error during PDF upload and processing' });
    }
};
export const processTicketOcr = async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await TicketService.processTicketOcr(id);
        return res.status(200).json(ticket);
    }
    catch (error) {
        console.error('processTicketOcr error', error);
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
export const getTickets = async (req, res) => {
    try {
        const { status, supplierId, source, startDate, endDate, search, page, limit } = req.query;
        const filters = {};
        if (status)
            filters.status = status;
        if (supplierId)
            filters.supplierId = supplierId;
        if (source)
            filters.source = source;
        if (startDate)
            filters.startDate = startDate;
        if (endDate)
            filters.endDate = endDate;
        if (search)
            filters.search = search;
        const pageNum = page ? parseInt(page) : undefined;
        const limitNum = limit ? parseInt(limit) : undefined;
        if (pageNum && limitNum) {
            filters.page = pageNum;
            filters.limit = limitNum;
        }
        const tickets = await TicketService.getTickets(filters);
        if (pageNum && limitNum) {
            const totalCount = await TicketService.countTickets(filters);
            return res.status(200).json({
                data: tickets,
                pagination: {
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(totalCount / limitNum),
                    totalCount,
                }
            });
        }
        return res.status(200).json(tickets);
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
export const getTicketStats = async (req, res) => {
    try {
        const stats = await TicketService.getTicketStats();
        return res.status(200).json(stats);
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
export const getTicketById = async (req, res) => {
    try {
        const ticket = await TicketService.getTicketById(req.params.id);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        return res.status(200).json(ticket);
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
export const linkTicketToOrder = async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required' });
        }
        const userId = req.user?.id; // Assuming auth middleware attaches user
        const ticket = await TicketService.linkTicketToOrder(req.params.id, orderId, userId);
        return res.status(200).json(ticket);
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
export const unlinkTicketFromOrder = async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required' });
        }
        await TicketService.unlinkTicketFromOrder(req.params.id, orderId);
        return res.status(204).send();
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
export const updateTicket = async (req, res) => {
    try {
        const ticket = await TicketService.updateTicket(req.params.id, req.body);
        return res.status(200).json(ticket);
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
export const deleteTicket = async (req, res) => {
    try {
        await TicketService.deleteTicket(req.params.id);
        return res.status(204).send();
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
/**
 * Get OCR job status for a specific ticket
 * Returns the most recent OCR job and its current state
 */
export const getOcrJobStatus = async (req, res) => {
    try {
        const { ticketId } = req.params;
        const ticket = await TicketService.getTicketById(ticketId);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        if (ticket.ocrJobs.length === 0) {
            return res.status(404).json({ error: 'No OCR jobs found for this ticket' });
        }
        // Return the most recent OCR job
        const latestJob = ticket.ocrJobs[0];
        return res.status(200).json(latestJob);
    }
    catch (error) {
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
/**
 * Manually trigger processing of all pending OCR jobs
 * Useful for debugging, testing, or manual intervention
 * Admin only endpoint (optional, you can add auth middleware)
 */
export const processPendingOcrJobsEndpoint = async (req, res) => {
    try {
        const jobsProcessed = await processPendingOcrJobs();
        return res.status(200).json({
            message: `Started processing ${jobsProcessed} pending OCR jobs`,
            jobsProcessed,
        });
    }
    catch (error) {
        console.error('processPendingOcrJobsEndpoint error', error);
        return res.status(500).json({ error: error.message || 'Unexpected error' });
    }
};
//# sourceMappingURL=ticket.controller.js.map