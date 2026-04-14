import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
export declare const listSuppliers: (_req: AuthRequest, res: Response) => Promise<void>;
export declare const createSupplier: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const updateSupplier: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteSupplier: (req: AuthRequest, res: Response) => Promise<void>;
export declare const addRate: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const removeRate: (req: AuthRequest, res: Response) => Promise<void>;
export declare const updateRate: (req: AuthRequest, res: Response) => Promise<void>;
//# sourceMappingURL=supplier.controller.d.ts.map