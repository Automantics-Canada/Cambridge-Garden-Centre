/**
 * File Storage Service
 * Now uses Supabase Storage instead of local file system
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadTicketImage, uploadInvoiceImage, uploadCsvFile, uploadTicketThumbnail } from './supabaseStorage.js';
import { generateThumbnail, deriveThumbnailPath, THUMBNAIL_CONTENT_TYPE } from './thumbnail.service.js';
import { pdfToPng } from 'pdf-to-png-converter';
import { env } from '../config/env.js';

const uploadsRoot = path.resolve(process.cwd(), 'uploads');

function safeExtension(originalName: string, fallback: string): string {
  const extension = path.extname(path.basename(originalName)).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : fallback;
}

async function saveLocalFile(
  buffer: Buffer,
  segments: string[],
): Promise<{ path: string; storedUrl: string; size: number; timestamp: string }> {
  const destination = path.resolve(uploadsRoot, ...segments);
  if (!destination.startsWith(`${uploadsRoot}${path.sep}`)) {
    throw new Error('Invalid local storage path');
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, buffer, { flag: 'wx' });
  return {
    path: segments.join('/'),
    storedUrl: `/uploads/${segments.join('/')}`,
    size: buffer.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Helper to convert PDF ticket buffer to PNG buffer if necessary using in-process converter
 */
async function convertPdfToPngIfNecessary(
  buffer: Buffer,
  originalName: string
): Promise<{ buffer: Buffer; name: string }> {
  const isPdf = originalName.toLowerCase().endsWith('.pdf') || 
    (buffer.length > 4 && buffer.toString('ascii', 0, 4) === '%PDF');

  if (isPdf) {
    console.log(`[FileStorage] Converting PDF "${originalName}" to PNG...`);
    try {
      const pages = await pdfToPng(buffer, {
        viewportScale: 3,
        pagesToProcess: [1],
        disableFontFace: false,
        useSystemFonts: true,
        enableXfa: true,
      });
      const imageBuffer = pages[0]?.content;
      if (!imageBuffer) throw new Error('PDF did not render a first page');
      const baseName = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
      console.log(`[FileStorage] Successfully converted PDF "${originalName}" to PNG`);

      return {
        buffer: Buffer.from(imageBuffer),
        name: `${baseName}.png`,
      };
    } catch (error) {
      console.error(`[FileStorage] PDF to PNG conversion failed:`, error);
    }
  }
  return { buffer, name: originalName };
}

export interface SavedTicketImage {
  /** Durable private reference of the untouched original. Always present. */
  imageUrl: string;
  /** Durable private reference of the derived thumbnail, or null on failure. */
  thumbnailUrl: string | null;
}

/**
 * Save a ticket image to Supabase Storage, plus a small derived thumbnail.
 *
 * The original upload is authoritative: it is the OCR input and the retained
 * proof-of-delivery record. Thumbnail generation is therefore strictly
 * best-effort and runs *after* the original is safely stored. A failure is
 * logged and returns a null thumbnailUrl; it never deletes or replaces the
 * original, and never fails the driver's upload. Rows left with a null
 * thumbnail are exactly what the backfill CLI retries, and the UI falls back to
 * the original in the meantime.
 */
export async function saveTicketImage(
  buffer: Buffer,
  originalName: string
): Promise<SavedTicketImage> {
  let result: Awaited<ReturnType<typeof uploadTicketImage>>;
  // Rasterised PDFs are thumbnailed from the PNG, not from the source PDF.
  let thumbnailSource: Buffer;

  try {
    const { buffer: processedBuffer, name: processedName } = await convertPdfToPngIfNecessary(buffer, originalName);
    const ticketId = uuidv4();
    result = env.storageDriver === 'local'
      ? await saveLocalFile(processedBuffer, [
          'tickets',
          ticketId,
          `${ticketId}-${Date.now()}${safeExtension(processedName, '.jpg')}`,
        ])
      : await uploadTicketImage(processedBuffer, ticketId, processedName);
    thumbnailSource = processedBuffer;

    console.log('[FileStorage] Ticket image stored');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[FileStorage] Failed to save ticket image:', errorMsg);
    throw error;
  }

  let thumbnailUrl: string | null = null;
  try {
    const thumbnail = await generateThumbnail(thumbnailSource);
    const thumbnailPath = deriveThumbnailPath(result.path);
    const uploaded = env.storageDriver === 'local'
      ? await saveLocalFile(thumbnail.buffer, thumbnailPath.split('/'))
      : await uploadTicketThumbnail(
          thumbnail.buffer,
          thumbnailPath,
          THUMBNAIL_CONTENT_TYPE
        );
    thumbnailUrl = uploaded.storedUrl;
    console.log(
      `[FileStorage] Thumbnail generated: ${thumbnail.sourceBytes} -> ${thumbnail.bytes} bytes`
    );
  } catch (error) {
    // Observable and retryable, never fatal. The original is already stored.
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[FileStorage] Thumbnail generation failed for ${result.path} (original retained, ` +
      `run "npm run backfill:thumbnails" to retry): ${errorMsg}`
    );
  }

  return { imageUrl: result.storedUrl, thumbnailUrl };
}

/**
 * Save invoice image to Supabase Storage
 * Returns a durable private reference for the uploaded file.
 */
export async function saveInvoiceImage(
  buffer: Buffer,
  originalName: string
): Promise<string> {
  try {
    const { buffer: processedBuffer, name: processedName } = await convertPdfToPngIfNecessary(buffer, originalName);
    const invoiceId = uuidv4();
    const result = env.storageDriver === 'local'
      ? await saveLocalFile(processedBuffer, [
          'invoices',
          invoiceId,
          `${invoiceId}-${Date.now()}${safeExtension(processedName, '.jpg')}`,
        ])
      : await uploadInvoiceImage(processedBuffer, invoiceId, processedName);
    
    console.log('[FileStorage] Invoice image stored');
    
    return result.storedUrl;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[FileStorage] Failed to save invoice image:', errorMsg);
    throw error;
  }
}

/**
 * Save pickup/delivery proof. Production keeps the existing Supabase object
 * layout; the guarded local adapter exists only for disposable browser QA.
 */
export async function saveDeliveryPhoto(
  buffer: Buffer,
  deliveryId: string,
  type: 'pickup' | 'delivery',
  originalName: string,
): Promise<string> {
  const result = env.storageDriver === 'local'
    ? await saveLocalFile(buffer, [
        'deliveries',
        deliveryId,
        `${deliveryId}-${type}-${Date.now()}${safeExtension(originalName, '.jpg')}`,
      ])
    : await uploadTicketImage(buffer, `${deliveryId}-${type}`, originalName);
  return result.storedUrl;
}

/**
 * Save CSV file to Supabase Storage
 * Returns a durable private reference for the uploaded file.
 */
export async function saveCsvFile(
  buffer: Buffer,
  originalName: string
): Promise<string> {
  try {
    const uploadId = uuidv4();
    const result = env.storageDriver === 'local'
      ? await saveLocalFile(buffer, ['csv-uploads', `${uploadId}-${Date.now()}.csv`])
      : await uploadCsvFile(buffer, originalName, uploadId);
    
    console.log('[FileStorage] CSV file stored');
    
    return result.storedUrl;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[FileStorage] Failed to save CSV file:', errorMsg);
    throw error;
  }
}

export default {
  saveTicketImage,
  saveInvoiceImage,
  saveDeliveryPhoto,
  saveCsvFile,
};
