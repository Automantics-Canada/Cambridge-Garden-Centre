export interface InvoiceOcrExtractionResult {
    supplierName: string | null;
    invoiceDate: Date | null;
    totalAmount: number | null;
    invoiceNumber: string | null;
    poNumber: string | null;
    lineItems: Array<{
        description: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        unit: string | null;
        poNumber: string | null;
    }>;
    rawResponse: any;
}
/**
 * Extract expense/invoice data using AWS Textract AnalyzeExpense
 */
export declare function extractExpenseFromLocalImage(imageUrl: string): Promise<InvoiceOcrExtractionResult>;
//# sourceMappingURL=invoiceOcr.service.d.ts.map