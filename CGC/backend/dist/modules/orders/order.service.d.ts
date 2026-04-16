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
    getOrders(filters: any): Promise<({
        supplier: {
            name: string;
            id: string;
            type: import("@prisma/client").$Enums.SupplierType;
            emailDomains: string[];
            keywords: string[];
            contactName: string | null;
            contactEmail: string | null;
            phone: string | null;
            address: string | null;
            active: boolean;
        } | null;
        tickets: {
            id: string;
            poNumber: string | null;
            quantity: import("@prisma/client/runtime/library").Decimal | null;
            unit: string | null;
            supplierId: string | null;
            ticketNumber: string | null;
            source: import("@prisma/client").$Enums.TicketSource;
            material: string | null;
            rateOnTicket: import("@prisma/client/runtime/library").Decimal | null;
            ticketDate: Date | null;
            imageUrl: string;
            ocrRawText: string;
            ocrConfidence: number;
            linkedOrderId: string | null;
            linkMethod: string | null;
            linkedById: string | null;
            status: import("@prisma/client").$Enums.TicketStatus;
            receivedAt: Date;
            driverId: string | null;
        }[];
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
    })[]>;
};
export declare const OrderImportService: {
    importFromCsv(buffer: Buffer, originalName?: string): Promise<ImportSummary>;
};
//# sourceMappingURL=order.service.d.ts.map