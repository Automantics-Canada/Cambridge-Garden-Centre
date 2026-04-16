/**
 * File Storage Service
 * Now uses Supabase Storage instead of local file system
 */
/**
 * Save ticket image to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export declare function saveTicketImage(buffer: Buffer, originalName: string): Promise<string>;
/**
 * Save invoice image to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export declare function saveInvoiceImage(buffer: Buffer, originalName: string): Promise<string>;
/**
 * Save CSV file to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export declare function saveCsvFile(buffer: Buffer, originalName: string): Promise<string>;
declare const _default: {
    saveTicketImage: typeof saveTicketImage;
    saveInvoiceImage: typeof saveInvoiceImage;
    saveCsvFile: typeof saveCsvFile;
};
export default _default;
//# sourceMappingURL=fileStorage.d.ts.map