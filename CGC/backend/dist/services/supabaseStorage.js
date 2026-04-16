/**
 * Supabase Storage Service
 * Handles document uploads (tickets, invoices, CSVs) to Supabase Storage
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);
/**
 * Upload ticket image to Supabase Storage
 */
export async function uploadTicketImage(buffer, ticketId, originalFilename) {
    try {
        const fileExtension = originalFilename.split('.').pop() || 'jpg';
        const timestamp = Date.now();
        const filename = `${ticketId}-${timestamp}.${fileExtension}`;
        const path = `tickets/${ticketId}/${filename}`;
        const { data, error } = await supabase.storage
            .from(env.supabaseStorageBucket)
            .upload(path, buffer, {
            cacheControl: '3600',
            upsert: false,
            contentType: `image/${fileExtension === 'pdf' ? 'pdf' : 'jpeg'}`,
        });
        if (error) {
            throw new Error(`Supabase upload error: ${error.message}`);
        }
        // Get public URL
        const { data: publicUrlData } = supabase.storage
            .from(env.supabaseStorageBucket)
            .getPublicUrl(path);
        return {
            path: data.path,
            publicUrl: publicUrlData.publicUrl,
            size: buffer.length,
            timestamp: new Date().toISOString(),
        };
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Supabase] Ticket upload error:', errorMsg);
        throw error;
    }
}
/**
 * Upload invoice image to Supabase Storage
 */
export async function uploadInvoiceImage(buffer, invoiceId, originalFilename) {
    try {
        const fileExtension = originalFilename.split('.').pop() || 'jpg';
        const timestamp = Date.now();
        const filename = `${invoiceId}-${timestamp}.${fileExtension}`;
        const path = `invoices/${invoiceId}/${filename}`;
        const { data, error } = await supabase.storage
            .from(env.supabaseStorageBucket)
            .upload(path, buffer, {
            cacheControl: '3600',
            upsert: false,
            contentType: `image/${fileExtension === 'pdf' ? 'pdf' : 'jpeg'}`,
        });
        if (error) {
            throw new Error(`Supabase upload error: ${error.message}`);
        }
        // Get public URL
        const { data: publicUrlData } = supabase.storage
            .from(env.supabaseStorageBucket)
            .getPublicUrl(path);
        return {
            path: data.path,
            publicUrl: publicUrlData.publicUrl,
            size: buffer.length,
            timestamp: new Date().toISOString(),
        };
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Supabase] Invoice upload error:', errorMsg);
        throw error;
    }
}
/**
 * Upload CSV file to Supabase Storage
 */
export async function uploadCsvFile(buffer, filename, uploadId) {
    try {
        const timestamp = Date.now();
        const finalFilename = `${uploadId || 'csv'}-${timestamp}.csv`;
        const path = `csv-uploads/${finalFilename}`;
        const { data, error } = await supabase.storage
            .from(env.supabaseStorageBucket)
            .upload(path, buffer, {
            cacheControl: '3600',
            upsert: false,
            contentType: 'text/csv',
        });
        if (error) {
            throw new Error(`Supabase upload error: ${error.message}`);
        }
        // Get public URL
        const { data: publicUrlData } = supabase.storage
            .from(env.supabaseStorageBucket)
            .getPublicUrl(path);
        return {
            path: data.path,
            publicUrl: publicUrlData.publicUrl,
            size: buffer.length,
            timestamp: new Date().toISOString(),
        };
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Supabase] CSV upload error:', errorMsg);
        throw error;
    }
}
/**
 * Delete a file from Supabase Storage
 */
export async function deleteFile(path) {
    try {
        const { error } = await supabase.storage
            .from(env.supabaseStorageBucket)
            .remove([path]);
        if (error) {
            throw new Error(`Supabase delete error: ${error.message}`);
        }
        console.log(`[Supabase] File deleted: ${path}`);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Supabase] File delete error:', errorMsg);
        throw error;
    }
}
/**
 * Get public URL for a file
 */
export function getPublicUrl(path) {
    const { data } = supabase.storage
        .from(env.supabaseStorageBucket)
        .getPublicUrl(path);
    return data.publicUrl;
}
/**
 * List all files in a folder
 */
export async function listFiles(folderPath) {
    try {
        const { data, error } = await supabase.storage
            .from(env.supabaseStorageBucket)
            .list(folderPath);
        if (error) {
            throw new Error(`Supabase list error: ${error.message}`);
        }
        return (data || []).map(file => `${folderPath}/${file.name}`);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Supabase] List files error:', errorMsg);
        return [];
    }
}
/**
 * Verify Supabase Storage connection
 */
export async function verifyStorageConnection() {
    try {
        const { data, error } = await supabase.storage.listBuckets();
        if (error) {
            console.error('[Supabase] Connection error:', error.message);
            return false;
        }
        const bucketExists = (data || []).some(bucket => bucket.name === env.supabaseStorageBucket);
        if (!bucketExists) {
            console.error(`[Supabase] Bucket "${env.supabaseStorageBucket}" not found`);
            return false;
        }
        console.log(`[Supabase] ✅ Storage connection verified, bucket: "${env.supabaseStorageBucket}"`);
        return true;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Supabase] Connection verification failed:', errorMsg);
        return false;
    }
}
export default {
    uploadTicketImage,
    uploadInvoiceImage,
    uploadCsvFile,
    deleteFile,
    getPublicUrl,
    listFiles,
    verifyStorageConnection,
};
//# sourceMappingURL=supabaseStorage.js.map