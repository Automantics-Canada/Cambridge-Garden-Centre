/**
 * Supabase Storage Service
 * Handles document uploads (tickets, invoices, CSVs) to Supabase Storage
 */

import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { toStorageReference, type StoredObjectLocation } from './storageAccess.js';

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

export interface UploadResult {
  path: string;
  storedUrl: string;
  size: number;
  timestamp: string;
}

/**
 * Returns the proper content type/mime type for a given file extension
 */
function getContentType(fileExtension: string): string {
  const ext = fileExtension.toLowerCase();
  if (ext === 'pdf') {
    return 'application/pdf';
  }
  if (ext === 'png') {
    return 'image/png';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  return 'image/jpeg';
}

/**
 * Supabase Storage's `cacheControl` option takes a number of seconds, not a
 * complete Cache-Control header: the SDK emits `max-age=<value>` itself. Passing
 * a full header string produced `max-age=public, max-age=31536000, immutable`,
 * which is malformed and would have been discarded.
 *
 * Every upload below writes to a versioned key containing a uuid and a
 * timestamp, so a given URL never points at different bytes and a one-year max
 * age is safe. Hourly revalidation was costing a round trip per image on list
 * screens that render dozens of them.
 */
const LONG_CACHE_SECONDS = '31536000';

export async function uploadTicketImage(
  buffer: Buffer,
  ticketId: string,
  originalFilename: string,
): Promise<UploadResult> {
  try {
    const fileExtension = originalFilename.split('.').pop() || 'jpg';
    const timestamp = Date.now();
    const filename = `${ticketId}-${timestamp}.${fileExtension}`;
    const path = `tickets/${ticketId}/${filename}`;

    const { data, error } = await supabase.storage
      .from(env.supabaseStorageBucket)
      .upload(path, buffer, {
        cacheControl: LONG_CACHE_SECONDS,
        upsert: false,
        contentType: getContentType(fileExtension),
      });

    if (error) {
      throw new Error(`Supabase upload error: ${error.message}`);
    }

    return {
      path: data.path,
      storedUrl: toStorageReference(data.path),
      size: buffer.length,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Supabase] Ticket upload error:', errorMsg);
    throw error;
  }
}

/**
 * Upload invoice image to Supabase Storage
 */
/**
 * Upload a derived thumbnail at a caller-supplied deterministic path.
 *
 * `upsert: true` deliberately differs from the originals above: the path is a
 * pure function of the original object, so a repeat write is the same bytes for
 * the same source. That is what makes the backfill safe to re-run.
 */
export async function uploadTicketThumbnail(
  buffer: Buffer,
  path: string,
  contentType: string,
): Promise<UploadResult> {
  const { data, error } = await supabase.storage
    .from(env.supabaseStorageBucket)
    .upload(path, buffer, {
      cacheControl: LONG_CACHE_SECONDS,
      upsert: true,
      contentType,
    });

  if (error) {
    throw new Error(`Supabase thumbnail upload error: ${error.message}`);
  }

  return {
    path: data.path,
    storedUrl: toStorageReference(data.path),
    size: buffer.length,
    timestamp: new Date().toISOString(),
  };
}

export async function uploadInvoiceImage(
  buffer: Buffer,
  invoiceId: string,
  originalFilename: string,
): Promise<UploadResult> {
  try {
    const fileExtension = originalFilename.split('.').pop() || 'jpg';
    const timestamp = Date.now();
    const filename = `${invoiceId}-${timestamp}.${fileExtension}`;
    const path = `invoices/${invoiceId}/${filename}`;

    const { data, error } = await supabase.storage
      .from(env.supabaseStorageBucket)
      .upload(path, buffer, {
        cacheControl: LONG_CACHE_SECONDS,
        upsert: false,
        contentType: getContentType(fileExtension),
      });

    if (error) {
      throw new Error(`Supabase upload error: ${error.message}`);
    }

    return {
      path: data.path,
      storedUrl: toStorageReference(data.path),
      size: buffer.length,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Supabase] Invoice upload error:', errorMsg);
    throw error;
  }
}

/**
 * Upload CSV file to Supabase Storage
 */
export async function uploadCsvFile(
  buffer: Buffer,
  filename: string,
  uploadId?: string,
): Promise<UploadResult> {
  try {
    const timestamp = Date.now();
    const finalFilename = `${uploadId || 'csv'}-${timestamp}.csv`;
    const path = `csv-uploads/${finalFilename}`;

    const { data, error } = await supabase.storage
      .from(env.supabaseStorageBucket)
      .upload(path, buffer, {
        cacheControl: LONG_CACHE_SECONDS,
        upsert: false,
        contentType: 'text/csv',
      });

    if (error) {
      throw new Error(`Supabase upload error: ${error.message}`);
    }

    return {
      path: data.path,
      storedUrl: toStorageReference(data.path),
      size: buffer.length,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Supabase] CSV upload error:', errorMsg);
    throw error;
  }
}

/**
 * Delete a file from Supabase Storage
 */
export async function deleteFile(path: string): Promise<void> {
  try {
    const { error } = await supabase.storage
      .from(env.supabaseStorageBucket)
      .remove([path]);

    if (error) {
      throw new Error(`Supabase delete error: ${error.message}`);
    }

    console.log(`[Supabase] File deleted: ${path}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Supabase] File delete error:', errorMsg);
    throw error;
  }
}

export function getStorageReference(path: string): string {
  return toStorageReference(path);
}

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Read a private object with the backend-only service role. */
export async function downloadStorageObject(
  location: StoredObjectLocation,
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  if (location.bucket !== env.supabaseStorageBucket) {
    throw new Error('Storage bucket mismatch');
  }
  const { data, error } = await supabase.storage
    .from(location.bucket)
    .download(location.path);
  if (error || !data) {
    throw new Error(`Supabase download error: ${error?.message || 'empty response'}`);
  }
  if (data.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Storage object exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
  }
  return {
    buffer: Buffer.from(await data.arrayBuffer()),
    contentType: data.type || 'application/octet-stream',
    filename: location.path.split('/').pop() || 'document',
  };
}

/**
 * List all files in a folder
 */
export async function listFiles(folderPath: string): Promise<string[]> {
  try {
    const { data, error } = await supabase.storage
      .from(env.supabaseStorageBucket)
      .list(folderPath);

    if (error) {
      throw new Error(`Supabase list error: ${error.message}`);
    }

    return (data || []).map(file => `${folderPath}/${file.name}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Supabase] List files error:', errorMsg);
    return [];
  }
}

/**
 * Verify Supabase Storage connection
 */
export async function verifyStorageConnection(): Promise<boolean> {
  if (env.storageDriver === 'local') {
    console.log('[Storage] Local QA storage enabled.');
    return true;
  }

  try {
    const { data, error } = await supabase.storage.listBuckets();

    if (error) {
      console.error('[Supabase] Connection error:', error.message);
      return false;
    }

    const bucket = (data || []).find(
      bucket => bucket.name === env.supabaseStorageBucket
    );

    if (!bucket) {
      console.error(
        `[Supabase] Bucket "${env.supabaseStorageBucket}" not found`
      );
      return false;
    }

    if (bucket.public !== false) {
      console.error(
        `[Supabase] Bucket "${env.supabaseStorageBucket}" must be private before this service can start`
      );
      return false;
    }

    console.log(
      `[Supabase] ✅ Storage connection verified, bucket: "${env.supabaseStorageBucket}"`
    );
    return true;
  } catch (error) {
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
  getStorageReference,
  downloadStorageObject,
  listFiles,
  verifyStorageConnection,
};
