/**
 * File Storage Service
 * Now uses Supabase Storage instead of local file system
 */

import { v4 as uuidv4 } from 'uuid';
import { uploadTicketImage, uploadInvoiceImage, uploadCsvFile } from './supabaseStorage.js';
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
    console.log(`[FileStorage] Converting PDF "${originalName}" to PNG directly...`);
    try {
      const pngPages = await pdfToPng(buffer, {
        viewportScale: 2.0,
        pagesToProcess: [1],
        disableFontFace: false,
        useSystemFonts: true,
        enableXfa: true,
      });

      if (pngPages && pngPages.length > 0 && pngPages[0]?.content) {
        const baseName = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
        console.log(`[FileStorage] Successfully converted PDF "${originalName}" to PNG directly`);
        return {
          buffer: pngPages[0].content,
          name: `${baseName}.png`,
        };
      }
    } catch (error) {
      console.error(`[FileStorage] PDF to PNG direct conversion failed:`, error);
    }
  }
  return { buffer, name: originalName };
}

/**
 * Save ticket image to Supabase Storage
 * Returns the public URL of the uploaded file
 */
export async function saveTicketImage(
  buffer: Buffer,
  originalName: string
): Promise<string> {
  try {
    const { buffer: processedBuffer, name: processedName } = await convertPdfToPngIfNecessary(buffer, originalName);
    const ticketId = uuidv4();
    const result = await uploadTicketImage(processedBuffer, ticketId, processedName);
    
    console.log(`[FileStorage] Ticket image uploaded: ${result.publicUrl}`);
    
    return result.publicUrl;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[FileStorage] Failed to save ticket image:', errorMsg);
    throw error;
  }
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