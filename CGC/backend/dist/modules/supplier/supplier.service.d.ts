import { SupplierType } from '@prisma/client';
export declare const SupplierService: {
    list(): Promise<({
        negotiatedRates: {
            id: string;
            unit: string;
            supplierId: string;
            createdAt: Date;
            productName: string;
            rate: import("@prisma/client/runtime/library").Decimal;
            effectiveFrom: Date;
            effectiveTo: Date | null;
            notes: string | null;
            createdById: string;
        }[];
    } & {
        name: string;
        id: string;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        phone: string | null;
        address: string | null;
        active: boolean;
    })[]>;
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
    addNegotiatedRate(supplierId: string, data: {
        productName: string;
        rate: number;
        unit: string;
        effectiveFrom: Date;
        effectiveTo?: Date;
        notes?: string;
        createdById: string;
    }): Promise<{
        id: string;
        unit: string;
        supplierId: string;
        createdAt: Date;
        productName: string;
        rate: import("@prisma/client/runtime/library").Decimal;
        effectiveFrom: Date;
        effectiveTo: Date | null;
        notes: string | null;
        createdById: string;
    }>;
    removeNegotiatedRate(rateId: string): Promise<{
        id: string;
        unit: string;
        supplierId: string;
        createdAt: Date;
        productName: string;
        rate: import("@prisma/client/runtime/library").Decimal;
        effectiveFrom: Date;
        effectiveTo: Date | null;
        notes: string | null;
        createdById: string;
    }>;
};
//# sourceMappingURL=supplier.service.d.ts.map