export interface ImportSummary {
    created: number;
    updated: number;
    skipped: number;
    errors: Array<{
        rowNumber: number;
        error: string;
    }>;
}
export declare const OrderPdfImportService: {
    importFromPdf(buffer: Buffer): Promise<ImportSummary>;
    /**
     * Fallback method for when Textract/PNG conversion fails.
     * Extracts text directly from PDF using PDFParse class.
     */
    importViaTextExtraction(buffer: Buffer): Promise<ImportSummary>;
};
//# sourceMappingURL=orderPdfImport.service.d.ts.map