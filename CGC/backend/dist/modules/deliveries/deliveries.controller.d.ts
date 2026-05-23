import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
export declare const getDeliveries: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const updateStatus: (req: AuthRequest, res: Response) => Promise<void>;
export declare const uploadPhoto: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=deliveries.controller.d.ts.map