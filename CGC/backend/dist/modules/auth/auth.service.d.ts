export type UserRole = 'AP_USER' | 'OWNER' | 'ADMIN';
export declare const AuthService: {
    register(email: string, password: string, name: string, role?: UserRole): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        phone: string | null;
        active: boolean;
        email: string;
        passwordHash: string;
        role: import("@prisma/client").$Enums.UserRole;
    }>;
    login(email: string, password: string): Promise<{
        token: string;
        user: {
            id: string;
            email: string;
            name: string;
            role: import("@prisma/client").$Enums.UserRole;
        };
    }>;
};
//# sourceMappingURL=auth.service.d.ts.map