/**
 * File Storage Service
 * Now uses Supabase Storage instead of local file system
 */

import { v4 as uuidv4 } from 'uuid';
import { uploadTicketImage, uploadInvoiceImage, uploadCsvFile, uploadTicketThumbnail } from './supabaseStorage.js';
import { generateThumbnail, deriveThumbnailPath, THUMBNAIL_CONTENT_TYPE } from './thumbnail.service.js';
import { pdfToPng } from 'pdf-to-png-converter';

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
  /** Public URL of the untouched original. Always present. */
  imageUrl: string;
  /** Public URL of the derived thumbnail, or null when generation failed. */
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
    result = await uploadTicketImage(processedBuffer, ticketId, processedName);
    thumbnailSource = processedBuffer;

    console.log(`[FileStorage] Ticket image uploaded: ${result.publicUrl}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[FileStorage] Failed to save ticket image:', errorMsg);
    throw error;
  }

  let thumbnailUrl: string | null = null;
  try {
    const thumbnail = await generateThumbnail(thumbnailSource);
    const thumbnailPath = deriveThumbnailPath(result.path);
    const uploaded = await uploadTicketThumbnail(
      thumbnail.buffer,
      thumbnailPath,
      THUMBNAIL_CONTENT_TYPE
    );
    thumbnailUrl = uploaded.publicUrl;
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

  return { imageUrl: result.publicUrl, thumbnailUrl };
}

/**
 * Save invoice image to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export async function saveInvoiceImage(
  buffer: Buffer,
  originalName: string
): Promise<string> {
  try {
    const { buffer: processedBuffer, name: processedName } = await convertPdfToPngIfNecessary(buffer, originalName);
    const invoiceId = uuidv4();
    const result = await uploadInvoiceImage(processedBuffer, invoiceId, processedName);
    
    console.log(`[FileStorage] Invoice image uploaded: ${result.publicUrl}`);
    
    return result.publicUrl;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[FileStorage] Failed to save invoice image:', errorMsg);
    throw error;
  }
}

/**
 * Save CSV file to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export async function saveCsvFile(
  buffer: Buffer,
  originalName: string
): Promise<string> {
  try {
    const uploadId = uuidv4();
    const result = await uploadCsvFile(buffer, originalName, uploadId);
    
    console.log(`[FileStorage] CSV file uploaded: ${result.publicUrl}`);
    
    return result.publicUrl;
  } catch (error) {
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
