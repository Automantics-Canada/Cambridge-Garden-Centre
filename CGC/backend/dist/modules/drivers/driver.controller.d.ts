import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
export declare const getDrivers: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const getLoggedInDriverProfile: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const createDriver: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const updateDriver: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getDriverDeliveries: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteDriver: (req: AuthRequest, res: Response) => Promise<void>;
//# sourceMappingURL=driver.controller.d.ts.map