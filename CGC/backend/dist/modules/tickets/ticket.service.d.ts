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
        };
        ocrJob: {
            id: string;
            status: import("@prisma/client").$Enums.OcrJobStatus;
            invoiceId: string | null;
            type: import("@prisma/client").$Enums.OcrJobType;
            errorMessage: string | null;
            provider: import("@prisma/client").$Enums.OcrProvider;
            startedAt: Date | null;
            finishedAt: Date | null;
            rawResponse: import("@prisma/client/runtime/library").JsonValue | null;
            ticketId: string | null;
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
        };
        ocrJob: {
            id: string;
            status: import("@prisma/client").$Enums.OcrJobStatus;
            invoiceId: string | null;
            type: import("@prisma/client").$Enums.OcrJobType;
            errorMessage: string | null;
            provider: import("@prisma/client").$Enums.OcrProvider;
            startedAt: Date | null;
            finishedAt: Date | null;
            rawResponse: import("@prisma/client/runtime/library").JsonValue | null;
            ticketId: string | null;
        };
    }>;
    processTicketOcr(ticketId: string): Promise<{
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
    }>;
    /**
     * Get all tickets with optional filtering
     */
    getTickets(filters?: {
        status?: TicketStatus;
        supplierId?: string;
        source?: TicketSource;
        startDate?: string;
        endDate?: string;
        search?: string;
    }): Promise<({
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
        driver: {
            name: string;
            id: string;
            createdAt: Date;
            phone: string;
            active: boolean;
        } | null;
        linkedOrder: {
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
        } | null;
    } & {
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
    })[]>;
    getTicketStats(): Promise<{
        unlinkedCount: number;
    }>;
    /**
     * Get a single ticket by ID
     */
    getTicketById(id: string): Promise<({
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
        driver: {
            name: string;
            id: string;
            createdAt: Date;
            phone: string;
            active: boolean;
        } | null;
        ocrJobs: {
            id: string;
            status: import("@prisma/client").$Enums.OcrJobStatus;
            invoiceId: string | null;
            type: import("@prisma/client").$Enums.OcrJobType;
            errorMessage: string | null;
            provider: import("@prisma/client").$Enums.OcrProvider;
            startedAt: Date | null;
            finishedAt: Date | null;
            rawResponse: import("@prisma/client/runtime/library").JsonValue | null;
            ticketId: string | null;
        }[];
        linkedOrder: {
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
        } | null;
    } & {
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
    }>;
    linkTicketToOrder(ticketId: string, orderId: string, userId?: string): Promise<{
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
    }>;
};
//# sourceMappingURL=ticket.service.d.ts.map