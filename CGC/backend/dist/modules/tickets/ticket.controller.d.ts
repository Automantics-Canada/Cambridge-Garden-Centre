import type { Request, Response } from 'express';
export declare const ingestWhatsappTicket: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Simulated email webhook:
 * multipart/form-data:
 *  - file: ticket image
 *  - fromEmail: sender email (e.g. "tickets@galtgravel.com")
 */
export declare const ingestEmailTicket: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const processTicketOcr: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getTickets: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getTicketStats: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getTicketById: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const linkTicketToOrder: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTicket: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteTicket: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Get OCR job status for a specific ticket
 * Returns the most recent OCR job and its current state
 */
export declare const getOcrJobStatus: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Manually trigger processing of all pending OCR jobs
 * Useful for debugging, testing, or manual intervention
 * Admin only endpoint (optional, you can add auth middleware)
 */
export declare const processPendingOcrJobsEndpoint: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=ticket.controller.d.ts.map