import { TicketService } from './ticket.service.js';
import { processPendingOcrJobs } from '../../services/ocrJobProcessor.js';
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
        const { status, supplierId, source, startDate, endDate, search } = req.query;
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
        const tickets = await TicketService.getTickets(filters);
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