import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
export declare const listProducts: (_req: AuthRequest, res: Response) => Promise<void>;
export declare const createProduct: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const updateProduct: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const deleteProduct: (req: AuthRequest, res: Response) => Promise<void>;
export declare const listUnits: (_req: AuthRequest, res: Response) => Promise<void>;
export declare const createUnit: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const deleteUnit: (req: AuthRequest, res: Response) => Promise<void>;
//# sourceMappingURL=product.controller.d.ts.map