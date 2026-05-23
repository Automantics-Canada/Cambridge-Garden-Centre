import { DeliveryStatus } from '@prisma/client';
export declare const DeliveriesService: {
    getDeliveries(filters: any): Promise<({
        order: {
            supplier: {
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
            } | null;
        } & {
            id: string;
            spruceOrderId: string;
            poNumber: string | null;
            customerName: string;
            buyerType: import("@prisma/client").$Enums.BuyerType;
            product: string;
            quantity: import("@prisma/client/runtime/library").Decimal;
            unit: string;
            supplierId: string | null;
            orderDate: Date;
            deliveryDate: Date | null;
            hasInvoice: boolean;
            invoiceNumber: string | null;
            createdAt: Date;
            deliveryStatus: import("@prisma/client").$Enums.DriverTaskStatus;
            driverId: string | null;
            priority: number;
        };
        driver: {
            name: string;
            id: string;
            createdAt: Date;
            phone: string;
            active: boolean;
            email: string | null;
            ratePerDelivery: import("@prisma/client/runtime/library").Decimal;
            ratePerTrip: import("@prisma/client/runtime/library").Decimal | null;
            type: import("@prisma/client").$Enums.DriverType;
            companyName: string | null;
            userId: string | null;
        } | null;
        history: {
            id: string;
            createdAt: Date;
            status: import("@prisma/client").$Enums.DeliveryStatus;
            notes: string | null;
            deliveryId: string;
        }[];
    } & {
        id: string;
        createdAt: Date;
        driverId: string | null;
        priority: number;
        orderId: string;
        status: import("@prisma/client").$Enums.DeliveryStatus;
        pickupType: string;
        pickupPhotoUrl: string | null;
        deliveryPhotoUrl: string | null;
        startedAt: Date | null;
        completedAt: Date | null;
    })[]>;
    updateStatus(id: string, status: DeliveryStatus, notes?: string): Promise<{
        order: {
            id: string;
            spruceOrderId: string;
            poNumber: string | null;
            customerName: string;
            buyerType: import("@prisma/client").$Enums.BuyerType;
            product: string;
            quantity: import("@prisma/client/runtime/library").Decimal;
            unit: string;
            supplierId: string | null;
            orderDate: Date;
            deliveryDate: Date | null;
            hasInvoice: boolean;
            invoiceNumber: string | null;
            createdAt: Date;
            deliveryStatus: import("@prisma/client").$Enums.DriverTaskStatus;
            driverId: string | null;
            priority: number;
        };
        driver: {
            name: string;
            id: string;
            createdAt: Date;
            phone: string;
            active: boolean;
            email: string | null;
            ratePerDelivery: import("@prisma/client/runtime/library").Decimal;
            ratePerTrip: import("@prisma/client/runtime/library").Decimal | null;
            type: import("@prisma/client").$Enums.DriverType;
            companyName: string | null;
            userId: string | null;
        } | null;
    } & {
        id: string;
        createdAt: Date;
        driverId: string | null;
        priority: number;
        orderId: string;
        status: import("@prisma/client").$Enums.DeliveryStatus;
        pickupType: string;
        pickupPhotoUrl: string | null;
        deliveryPhotoUrl: string | null;
        startedAt: Date | null;
        completedAt: Date | null;
    }>;
    uploadPhoto(id: string, type: "pickup" | "delivery", fileBuffer: Buffer, filename: string): Promise<{
        id: string;
        createdAt: Date;
        driverId: string | null;
        priority: number;
        orderId: string;
        status: import("@prisma/client").$Enums.DeliveryStatus;
        pickupType: string;
        pickupPhotoUrl: string | null;
        deliveryPhotoUrl: string | null;
        startedAt: Date | null;
        completedAt: Date | null;
    }>;
};
//# sourceMappingURL=deliveries.service.d.ts.map