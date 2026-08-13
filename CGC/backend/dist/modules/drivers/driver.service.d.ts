import { DriverType } from '@prisma/client';
export declare const DriverService: {
    getDrivers(): Promise<{
        stats: {
            totalToday: number;
            completedToday: number;
            progress: number;
        };
        currentTask: ({
            order: {
                id: string;
                spruceOrderId: string;
                poNumber: string | null;
                customerName: string | null;
                buyerType: import("@prisma/client").$Enums.BuyerType | null;
                product: string | null;
                quantity: import("@prisma/client/runtime/library").Decimal | null;
                unit: string | null;
                supplierId: string | null;
                orderDate: Date | null;
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
        }) | null;
        deliveries: ({
            order: {
                id: string;
                spruceOrderId: string;
                poNumber: string | null;
                customerName: string | null;
                buyerType: import("@prisma/client").$Enums.BuyerType | null;
                product: string | null;
                quantity: import("@prisma/client/runtime/library").Decimal | null;
                unit: string | null;
                supplierId: string | null;
                orderDate: Date | null;
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
    }[]>;
    createDriver(data: {
        name: string;
        phone: string;
        email?: string;
        password?: string;
        type?: DriverType;
        companyName?: string;
        ratePerDelivery?: number;
        ratePerTrip?: number;
        active?: boolean;
    }): Promise<{
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
    }>;
    updateDriver(id: string, data: any): Promise<{
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
    }>;
    getDriverDeliveries(driverId: string): Promise<({
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
            tickets: {
                id: string;
                poNumber: string | null;
                quantity: import("@prisma/client/runtime/library").Decimal | null;
                unit: string | null;
                supplierId: string | null;
                deliveryStatus: import("@prisma/client").$Enums.DriverTaskStatus;
                driverId: string | null;
                status: import("@prisma/client").$Enums.TicketStatus;
                ticketNumber: string | null;
                source: import("@prisma/client").$Enums.TicketSource;
                supplierName: string | null;
                material: string | null;
                rateOnTicket: import("@prisma/client/runtime/library").Decimal | null;
                ticketDate: Date | null;
                imageUrl: string;
                ocrRawText: string;
                ocrConfidence: number;
                linkedOrderId: string | null;
                linkMethod: string | null;
                linkedById: string | null;
                receivedAt: Date;
                spruceMatched: boolean;
            }[];
        } & {
            id: string;
            spruceOrderId: string;
            poNumber: string | null;
            customerName: string | null;
            buyerType: import("@prisma/client").$Enums.BuyerType | null;
            product: string | null;
            quantity: import("@prisma/client/runtime/library").Decimal | null;
            unit: string | null;
            supplierId: string | null;
            orderDate: Date | null;
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
    })[]>;
    getDriverByUserId(userId: string): Promise<{
        stats: {
            totalToday: number;
            completedToday: number;
            progress: number;
        };
        currentTask: ({
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
                customerName: string | null;
                buyerType: import("@prisma/client").$Enums.BuyerType | null;
                product: string | null;
                quantity: import("@prisma/client/runtime/library").Decimal | null;
                unit: string | null;
                supplierId: string | null;
                orderDate: Date | null;
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
        }) | null;
        deliveries: ({
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
                customerName: string | null;
                buyerType: import("@prisma/client").$Enums.BuyerType | null;
                product: string | null;
                quantity: import("@prisma/client/runtime/library").Decimal | null;
                unit: string | null;
                supplierId: string | null;
                orderDate: Date | null;
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
    } | null>;
    deleteDriver(id: string): Promise<{
        user: {
            name: string;
            id: string;
            createdAt: Date;
            phone: string | null;
            active: boolean;
            email: string;
            passwordHash: string;
            role: import("@prisma/client").$Enums.UserRole;
        } | null;
    } & {
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
    }>;
};
//# sourceMappingURL=driver.service.d.ts.map