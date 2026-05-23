export declare const DispatchService: {
    getDispatchBoard(): Promise<{
        unassignedOrders: ({
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
        })[];
        unassignedDeliveries: ({
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
        })[];
        drivers: {
            deliveries: ({
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
            })[];
            todayDeliveries: number;
            completedToday: number;
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
        }[];
    }>;
    assignDriver(orderId: string, driverId: string, priority?: number): Promise<{
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
    unassignDriver(orderId: string): Promise<{
        success: boolean;
    }>;
    reorderDeliveries(driverId: string, deliveryIds: string[]): Promise<{
        success: boolean;
    }>;
    resendAssignmentEmail(deliveryId: string): Promise<{
        success: boolean;
        messageId: any;
        error?: never;
    } | {
        success: boolean;
        error: any;
        messageId?: never;
    }>;
};
//# sourceMappingURL=dispatch.service.d.ts.map