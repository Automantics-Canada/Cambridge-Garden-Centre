export interface ImportSummary {
    created: number;
    updated: number;
    skipped: number;
    errors: Array<{
        rowNumber: number;
        error: string;
    }>;
}
export declare const OrderService: {
    getOrders(filters: any): Promise<{
        data: ({
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
            ticketMatches: ({
                ticket: {
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
                };
            } & {
                id: string;
                orderId: string;
                ticketId: string;
                matchMethod: string;
                matchedAt: Date;
                createdBy: string | null;
            })[];
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
        })[];
        pagination: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
};
export declare const OrderImportService: {
    importFromCsv(buffer: Buffer, originalName?: string): Promise<ImportSummary>;
};
//# sourceMappingURL=order.service.d.ts.map