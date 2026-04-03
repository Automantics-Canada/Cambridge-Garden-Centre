import { TicketService } from './ticket.service.js';
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
        const { status, supplierId } = req.query;
        const filters = {};
        if (status)
            filters.status = status;
        if (supplierId)
            filters.supplierId = supplierId;
        const tickets = await TicketService.getTickets(filters);
        return res.status(200).json(tickets);
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
//# sourceMappingURL=ticket.controller.js.map