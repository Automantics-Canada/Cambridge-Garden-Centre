/**
 * URL Handler Service
 * Utility functions for downloading files from URLs
 */

import axios from 'axios';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { env } from '../config/env.js';

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

/**
 * Download file from URL and save to temporary location
 */
export async function downloadFileToTemp(
  url: string,
  filename?: string
): Promise<string> {
  try {
    await ensureTempDir();

    // Generate filename if not provided
    const finalFilename = filename || `temp-${Date.now()}.tmp`;
    const tempPath = path.join(TEMP_DIR, finalFilename);

    // Download file
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
    });

    // Save to temp
    await fs.writeFile(tempPath, response.data);

    console.log(`[URLHandler] File downloaded to temp: ${tempPath}`);
    return tempPath;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[URLHandler] Download error:', errorMsg);
    throw error;
  }
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
 * Check if URL is a Supabase Storage URL
 */
export function isSupabaseUrl(url: string): boolean {
  return url.includes('supabase.co') || url.includes(env.supabaseUrl);
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
  downloadFileToTemp,
  cleanupTempFile,
  isSupabaseUrl,
  getFilenameFromUrl,
};
