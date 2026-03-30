import type { Request, Response } from 'express';
export type UserRole = 'AP_USER' | 'OWNER' | 'ADMIN';
export declare const register: (req: Request, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const login: (req: Request, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=auth.controller.d.ts.map