/**
 * File Storage Service
 * Now uses Supabase Storage instead of local file system
 */
import { v4 as uuidv4 } from 'uuid';
import { uploadTicketImage, uploadInvoiceImage, uploadCsvFile } from './supabaseStorage.js';
/**
 * Save ticket image to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export async function saveTicketImage(buffer, originalName) {
    try {
        const ticketId = uuidv4();
        const result = await uploadTicketImage(buffer, ticketId, originalName);
        console.log(`[FileStorage] Ticket image uploaded: ${result.publicUrl}`);
        return result.publicUrl;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[FileStorage] Failed to save ticket image:', errorMsg);
        throw error;
    }
}
/**
 * Save invoice image to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export async function saveInvoiceImage(buffer, originalName) {
    try {
        const invoiceId = uuidv4();
        const result = await uploadInvoiceImage(buffer, invoiceId, originalName);
        console.log(`[FileStorage] Invoice image uploaded: ${result.publicUrl}`);
        return result.publicUrl;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[FileStorage] Failed to save invoice image:', errorMsg);
        throw error;
    }
}
/**
 * Save CSV file to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export async function saveCsvFile(buffer, originalName) {
    try {
        const uploadId = uuidv4();
        const result = await uploadCsvFile(buffer, originalName, uploadId);
        console.log(`[FileStorage] CSV file uploaded: ${result.publicUrl}`);
        return result.publicUrl;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[FileStorage] Failed to save CSV file:', errorMsg);
        throw error;
    }
}
export default {
    saveTicketImage,
    saveInvoiceImage,
    saveCsvFile,
};
//# sourceMappingURL=fileStorage.js.map