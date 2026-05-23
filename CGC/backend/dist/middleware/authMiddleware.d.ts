import type { NextFunction, Request, Response } from 'express';
export type UserRole = 'AP_USER' | 'OWNER' | 'ADMIN' | 'DRIVER';
export interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
        role: UserRole;
    };
}
export declare function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void | Response<any, Record<string, any>>>;
export declare function requireRole(roles: UserRole[]): (req: AuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=authMiddleware.d.ts.map