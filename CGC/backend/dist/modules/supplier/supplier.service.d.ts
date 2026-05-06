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
        phone: string | null;
        active: boolean;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        address: string | null;
        keywords: string[];
    })[]>;
    create(data: {
        name: string;
        type: SupplierType;
        emailDomains: string[];
        keywords: string[];
        contactName?: string;
        contactEmail?: string;
        phone?: string;
        address?: string;
    }): Promise<{
        name: string;
        id: string;
        phone: string | null;
        active: boolean;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        address: string | null;
        keywords: string[];
    }>;
    update(id: string, data: Partial<{
        name: string;
        type: SupplierType;
        emailDomains: string[];
        keywords: string[];
        contactName?: string;
        contactEmail?: string;
        phone?: string;
        address?: string;
        active?: boolean;
    }>): Promise<{
        name: string;
        id: string;
        phone: string | null;
        active: boolean;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        address: string | null;
        keywords: string[];
    }>;
    remove(id: string): Promise<{
        name: string;
        id: string;
        phone: string | null;
        active: boolean;
        type: import("@prisma/client").$Enums.SupplierType;
        emailDomains: string[];
        contactName: string | null;
        contactEmail: string | null;
        address: string | null;
        keywords: string[];
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
    updateNegotiatedRate(rateId: string, data: Partial<{
        productName: string;
        rate: number;
        unit: string;
        effectiveFrom: Date;
        effectiveTo?: Date;
        notes?: string;
    }>): Promise<{
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