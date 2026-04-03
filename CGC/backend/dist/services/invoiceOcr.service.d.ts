export interface InvoiceOcrExtractionResult {
    supplierName: string | null;
    invoiceDate: Date | null;
    totalAmount: number | null;
    invoiceNumber: string | null;
    lineItems: Array<{
        description: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
    }>;
    rawResponse: any;
}
export declare function extractExpenseFromLocalImage(imageUrl: string): Promise<InvoiceOcrExtractionResult>;
//# sourceMappingURL=invoiceOcr.service.d.ts.map