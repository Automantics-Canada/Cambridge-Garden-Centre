/**
 * URL Handler Service
 * Utility functions for downloading files from URLs
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { downloadStorageObject } from './supabaseStorage.js';
import { parseStoredObjectLocation } from './storageAccess.js';

const TEMP_DIR = path.join(process.cwd(), '.temp-ocr');

/**
 * Ensure temp directory exists
 */
async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

/** Materialise a private storage object for Textract without making it public. */
export async function downloadStoredFileToTemp(
  reference: string,
  filename?: string,
): Promise<string> {
  await ensureTempDir();
  const location = parseStoredObjectLocation(reference);
  if (!location) throw new Error('Unsupported storage object reference');
  const object = await downloadStorageObject(location);
  const safeName = path.basename(filename || object.filename || 'document.tmp');
  const tempPath = path.join(TEMP_DIR, `${randomUUID()}-${safeName}`);
  await fs.writeFile(tempPath, object.buffer, { flag: 'wx' });
  return tempPath;
}

export function isStoredFileLocation(value: string): boolean {
  return parseStoredObjectLocation(value) !== null;
}

/**
 * Clean up temporary file
 */
export async function cleanupTempFile(tempPath: string): Promise<void> {
  try {
    if (tempPath && tempPath.startsWith(TEMP_DIR)) {
      await fs.unlink(tempPath);
      console.log(`[URLHandler] Temp file cleaned up: ${tempPath}`);
    }
  } catch (error) {
    // File might already be deleted
    console.warn(`[URLHandler] Failed to cleanup temp file: ${tempPath}`);
  }
}

/**
 * Get filename from URL or path
 */
export function getFilenameFromUrl(url: string): string {
  const urlParts = url.split('/');
  const lastPart = urlParts[urlParts.length - 1];
  return (lastPart?.split('?')[0]) || 'file.tmp';
}

export default {
  downloadStoredFileToTemp,
  cleanupTempFile,
  isStoredFileLocation,
  getFilenameFromUrl,
};
