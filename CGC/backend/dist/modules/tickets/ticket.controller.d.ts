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
export declare const getTicketById: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTicket: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteTicket: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=ticket.controller.d.ts.map