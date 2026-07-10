/**
 * File Storage Service
 * Now uses Supabase Storage instead of local file system
 */

import { v4 as uuidv4 } from 'uuid';
import { uploadTicketImage, uploadInvoiceImage, uploadCsvFile } from './supabaseStorage.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-ignore
import pdfPoppler from 'pdf-poppler';

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
    console.log(`[FileStorage] Converting PDF "${originalName}" to JPG using pdf-poppler...`);
    const tempId = uuidv4();
    const tempDir = os.tmpdir();
    const pdfPath = path.join(tempDir, `${tempId}.pdf`);
    const jpgPath = path.join(tempDir, `${tempId}-1.jpg`);

    try {
      fs.writeFileSync(pdfPath, buffer);

      const opts = {
        format: 'jpeg',
        out_dir: tempDir,
        out_prefix: tempId,
        page: 1
      };

      await pdfPoppler.convert(pdfPath, opts);

      if (fs.existsSync(jpgPath)) {
        const imageBuffer = fs.readFileSync(jpgPath);
        const baseName = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
        console.log(`[FileStorage] Successfully converted PDF "${originalName}" to JPG`);
        
        // Clean up temp files
        fs.unlinkSync(pdfPath);
        fs.unlinkSync(jpgPath);

        return {
          buffer: imageBuffer,
          name: `${baseName}.jpg`,
        };
      }
    } catch (error) {
      console.error(`[FileStorage] PDF to JPG conversion failed:`, error);
      try {
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
        if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath);
      } catch (cleanupErr) {
        // ignore
      }
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