import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
export declare const importOrdersFromCsv: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getOrders: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=order.controller.d.ts.map