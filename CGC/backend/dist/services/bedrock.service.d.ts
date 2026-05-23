export interface BedrockExtractionResult {
    supplierName: string | null;
    date: Date | null;
    invoiceNumber?: string | null;
    ticketNumber?: string | null;
    totalAmount?: number | null;
    poNumber: string | null;
    material?: string | null;
    quantity: number | null;
    unit?: string | null;
    lineItems?: Array<{
        description: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        unit: string;
        poNumber: string | null;
    }>;
}
/**
 * Uses AWS Bedrock to extract structured data from raw OCR text.
 */
export declare function extractStructuredData(rawText: string, docType: 'TICKET' | 'INVOICE'): Promise<BedrockExtractionResult>;
//# sourceMappingURL=bedrock.service.d.ts.map