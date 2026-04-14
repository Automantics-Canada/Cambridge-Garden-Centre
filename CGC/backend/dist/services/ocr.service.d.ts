export interface OcrExtractionResult {
    rawText: string;
    supplierName: string | null;
    ticketDate: Date | null;
    material: string | null;
    quantity: number | null;
    poNumber: string | null;
    ticketNumber: string | null;
    ocrConfidence: number;
}
export declare function extractTextFromLocalImage(imageUrl: string): Promise<OcrExtractionResult>;
//# sourceMappingURL=ocr.service.d.ts.map