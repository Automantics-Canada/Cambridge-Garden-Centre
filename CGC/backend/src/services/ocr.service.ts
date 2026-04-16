import {
  TextractClient,
  DetectDocumentTextCommand,
} from '@aws-sdk/client-textract';
import path from 'node:path';
import fs from 'node:fs';
import { downloadFileToTemp, cleanupTempFile, isSupabaseUrl, getFilenameFromUrl } from './urlHandler.js';

const textractClient = new TextractClient(); // Relies on standard AWS credential provider chain

export interface OcrExtractionResult {
  rawText: string;
  supplierName: string | null;
  ticketDate: Date | null;
  material: string | null;
  quantity: number | null;
  poNumber: string | null;
  ticketNumber: string | null;
  ocrConfidence: number;
}

/**
 * Extract text from local image using AWS Textract
 */
export async function extractTextFromLocalImage(imageUrl: string): Promise<OcrExtractionResult> {
  let localPath = imageUrl;
  let tempFile: string | null = null;

  try {
    // Handle Supabase URLs
    if (isSupabaseUrl(imageUrl)) {
      console.log(`[OCR] Downloading from Supabase: ${imageUrl.substring(0, 50)}...`);
      const filename = getFilenameFromUrl(imageUrl);
      tempFile = await downloadFileToTemp(imageUrl, filename);
      localPath = tempFile;
    } else if (imageUrl.startsWith('/uploads/')) {
      // Handle legacy local paths
      localPath = path.join(process.cwd(), imageUrl);
    }

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file not found for OCR: ${localPath}`);
    }

    // Extract text using AWS Textract
    return await extractWithTextract(localPath);
  } finally {
    // Clean up temporary file if it was downloaded
    if (tempFile) {
      await cleanupTempFile(tempFile);
    }
  }
}

/**
 * Extract text using AWS Textract
 */
async function extractWithTextract(localPath: string): Promise<OcrExtractionResult> {
  const imageBytes = fs.readFileSync(localPath);

  const command = new DetectDocumentTextCommand({
    Document: {
      Bytes: imageBytes,
    },
  });

  const result = await textractClient.send(command);
  const blocks = result.Blocks;

  if (!blocks || blocks.length === 0) {
    throw new Error('No text detected in the image');
  }

  const lineBlocks = blocks.filter((block: any) => block.BlockType === 'LINE' && block.Text);
  const textLines = lineBlocks.map((block: any) => block.Text as string);
  const rawText = textLines.join('\n');

  // Calculate average confidence
  const totalConfidence = lineBlocks.reduce((acc: number, block: any) => acc + (block.Confidence || 0), 0);
  const averageConfidence = lineBlocks.length > 0 ? totalConfidence / lineBlocks.length : 0;

  const extraction = parseTicketData(rawText);
  return {
    ...extraction,
    ocrConfidence: averageConfidence,
  };
}

/**
 * Legacy Textract-only parsing function (kept for backward compatibility)
 */
function parseTicketData(text: string): Omit<OcrExtractionResult, 'ocrConfidence'> {
  const result: Omit<OcrExtractionResult, 'ocrConfidence'> = {
    rawText: text,
    supplierName: null,
    ticketDate: null,
    material: null,
    quantity: null,
    poNumber: null,
    ticketNumber: null,
  };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length > 0) {
    result.supplierName = lines[0] || null;
  }

  const dateRegex = /\b(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\b/;
  const dateMatch = text.match(dateRegex);
  if (dateMatch && dateMatch[1]) {
    const parsedDate = new Date(dateMatch[1]);
    if (!isNaN(parsedDate.getTime())) {
      result.ticketDate = parsedDate;
    }
  }

  const ticketRegex = /Ticket\s*#?\s*[:\-]?\s*([A-Za-z0-9]+)/i;
  const ticketMatch = text.match(ticketRegex);
  if (ticketMatch && ticketMatch[1]) {
    result.ticketNumber = ticketMatch[1] || null;
  }

  const poRegex = /PO\s*#?\s*[:\-]?\s*([A-Za-z0-9]+)/i;
  const poMatch = text.match(poRegex);
  if (poMatch && poMatch[1]) {
    result.poNumber = poMatch[1];
  }

  const qtyRegex = /([\d.,]+)\s*(tons?|tonnes?|lbs?|kg|t)/i;
  const qtyMatch = text.match(qtyRegex);
  if (qtyMatch && qtyMatch[1]) {
    const qtyVal = parseFloat(qtyMatch[1].replace(/,/g, ''));
    if (!isNaN(qtyVal)) {
      result.quantity = qtyVal;
    }
  }

  const materials = ['sand', 'gravel', 'stone', 'aggregate', 'crush', 'soil', 'asphalt'];
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (materials.some(m => lowerLine.includes(m))) {
      result.material = line;
      break;
    }
  }

  return result;
}
