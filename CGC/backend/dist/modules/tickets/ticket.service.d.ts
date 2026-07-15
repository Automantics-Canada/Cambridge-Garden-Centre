import { TicketSource, TicketStatus } from '@prisma/client';
export declare const TicketService: {
    /**
     * Ticket arrives via WhatsApp: save file, create Ticket, queue OCR.
     */
    ingestWhatsappTicket(params: {
        buffer: Buffer;
        originalName: string;
        fromPhone: string;
    }): Promise<{
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
        ocrJob: {
            id: string;
            status: import("@prisma/client").$Enums.OcrJobStatus;
            startedAt: Date | null;
            invoiceId: string | null;
            ticketId: string | null;
            type: import("@prisma/client").$Enums.OcrJobType;
            errorMessage: string | null;
            finishedAt: Date | null;
            provider: import("@prisma/client").$Enums.OcrProvider;
            rawResponse: import("@prisma/client/runtime/library").JsonValue | null;
        };
    }>;
    /**
     * Ticket arrives via email: save file, create Ticket, queue OCR.
     */
    ingestEmailTicket(params: {
        buffer: Buffer;
        originalName: string;
        fromEmail: string;
    }): Promise<{
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
        ocrJob: {
            id: string;
            status: import("@prisma/client").$Enums.OcrJobStatus;
            startedAt: Date | null;
            invoiceId: string | null;
            ticketId: string | null;
            type: import("@prisma/client").$Enums.OcrJobType;
            errorMessage: string | null;
            finishedAt: Date | null;
            provider: import("@prisma/client").$Enums.OcrProvider;
            rawResponse: import("@prisma/client/runtime/library").JsonValue | null;
        };
    }>;
    /**
     * Ticket uploaded manually by admin: save file, create Ticket, queue OCR.
     */
    ingestManualTicket(params: {
        buffer: Buffer;
        originalName: string;
    }, waitOcr?: boolean): Promise<{
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
        ocrJob: {
            id: string;
            status: import("@prisma/client").$Enums.OcrJobStatus;
            startedAt: Date | null;
            invoiceId: string | null;
            ticketId: string | null;
            type: import("@prisma/client").$Enums.OcrJobType;
            errorMessage: string | null;
            finishedAt: Date | null;
            provider: import("@prisma/client").$Enums.OcrProvider;
            rawResponse: import("@prisma/client/runtime/library").JsonValue | null;
        };
    }>;
    processTicketOcr(ticketId: string): Promise<{
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
    }>;
    /**
     * Get all tickets with optional filtering and pagination
     */
    getTickets(filters?: {
        status?: TicketStatus;
        supplierId?: string;
        source?: TicketSource;
        startDate?: string;
        endDate?: string;
        search?: string;
        page?: number;
        limit?: number;
    }): Promise<{
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
    }[]>;
    countTickets(filters?: {
        status?: TicketStatus;
        supplierId?: string;
        source?: TicketSource;
        startDate?: string;
        endDate?: string;
        search?: string;
    }): Promise<number>;
    getTicketStats(): Promise<{
        unlinkedCount: number;
    }>;
    /**
     * Get a single ticket by ID
     */
    getTicketById(id: string): Promise<({
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
        ocrJobs: {
            id: string;
            status: import("@prisma/client").$Enums.OcrJobStatus;
            startedAt: Date | null;
            invoiceId: string | null;
            ticketId: string | null;
            type: import("@prisma/client").$Enums.OcrJobType;
            errorMessage: string | null;
            finishedAt: Date | null;
            provider: import("@prisma/client").$Enums.OcrProvider;
            rawResponse: import("@prisma/client/runtime/library").JsonValue | null;
        }[];
        linkedOrder: {
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
        } | null;
        orderMatches: ({
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
            orderId: string;
            ticketId: string;
            matchMethod: string;
            matchedAt: Date;
            createdBy: string | null;
        })[];
    } & {
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
    }) | null>;
    /**
     * Update a ticket
     */
    updateTicket(id: string, data: any): Promise<{
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
    }>;
    unlinkTicketFromOrder(ticketId: string, orderId: string): Promise<void>;
    linkTicketToOrder(ticketId: string, orderId: string, userId?: string): Promise<{
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
    }>;
    /**
     * Delete a ticket
     */
    deleteTicket(id: string): Promise<{
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
    }>;
};
//# sourceMappingURL=ticket.service.d.ts.map