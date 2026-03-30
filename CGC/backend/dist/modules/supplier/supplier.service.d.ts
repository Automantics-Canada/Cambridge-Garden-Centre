import { SupplierType } from '@prisma/client';
export declare const SupplierService: {
    list(): Promise<{
        name: string;
        id: string;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        phone: string | null;
        address: string | null;
        active: boolean;
    }[]>;
    create(data: {
        name: string;
        type: SupplierType;
        emailDomains: string[];
        contactName?: string;
        contactEmail?: string;
        phone?: string;
        address?: string;
    }): Promise<{
        name: string;
        id: string;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        phone: string | null;
        address: string | null;
        active: boolean;
    }>;
    update(id: string, data: Partial<{
        name: string;
        type: SupplierType;
        emailDomains: string[];
        contactName?: string;
        contactEmail?: string;
        phone?: string;
        address?: string;
        active?: boolean;
    }>): Promise<{
        name: string;
        id: string;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        phone: string | null;
        address: string | null;
        active: boolean;
    }>;
    remove(id: string): Promise<{
        name: string;
        id: string;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        phone: string | null;
        address: string | null;
        active: boolean;
    }>;
};
//# sourceMappingURL=supplier.service.d.ts.map