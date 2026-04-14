import type { Request, Response, NextFunction } from 'express';
export declare const InvoiceController: {
    ingestMockEmail(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    getInvoices(req: Request, res: Response, next: NextFunction): Promise<void>;
    getInvoiceById(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    verifyInvoice(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    disputeInvoice(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    reopenInvoice(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
};
//# sourceMappingURL=invoice.controller.d.ts.map