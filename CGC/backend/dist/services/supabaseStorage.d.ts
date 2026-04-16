/**
 * Supabase Storage Service
 * Handles document uploads (tickets, invoices, CSVs) to Supabase Storage
 */
export interface UploadResult {
    path: string;
    publicUrl: string;
    size: number;
    timestamp: string;
}
/**
 * Upload ticket image to Supabase Storage
 */
export declare function uploadTicketImage(buffer: Buffer, ticketId: string, originalFilename: string): Promise<UploadResult>;
/**
 * Upload invoice image to Supabase Storage
 */
export declare function uploadInvoiceImage(buffer: Buffer, invoiceId: string, originalFilename: string): Promise<UploadResult>;
/**
 * Upload CSV file to Supabase Storage
 */
export declare function uploadCsvFile(buffer: Buffer, filename: string, uploadId?: string): Promise<UploadResult>;
/**
 * Delete a file from Supabase Storage
 */
export declare function deleteFile(path: string): Promise<void>;
/**
 * Get public URL for a file
 */
export declare function getPublicUrl(path: string): string;
/**
 * List all files in a folder
 */
export declare function listFiles(folderPath: string): Promise<string[]>;
/**
 * Verify Supabase Storage connection
 */
export declare function verifyStorageConnection(): Promise<boolean>;
declare const _default: {
    uploadTicketImage: typeof uploadTicketImage;
    uploadInvoiceImage: typeof uploadInvoiceImage;
    uploadCsvFile: typeof uploadCsvFile;
    deleteFile: typeof deleteFile;
    getPublicUrl: typeof getPublicUrl;
    listFiles: typeof listFiles;
    verifyStorageConnection: typeof verifyStorageConnection;
};
export default _default;
//# sourceMappingURL=supabaseStorage.d.ts.map