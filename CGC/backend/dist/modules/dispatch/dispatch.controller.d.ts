import type { Request, Response } from 'express';
export declare const getDispatchBoard: (req: Request, res: Response) => Promise<void>;
export declare const assignDriver: (req: Request, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const unassignDriver: (req: Request, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const reorderDeliveries: (req: Request, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const resendEmail: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=dispatch.controller.d.ts.map