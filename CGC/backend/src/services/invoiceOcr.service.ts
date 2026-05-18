import {
  TextractClient,
  AnalyzeExpenseCommand,
} from '@aws-sdk/client-textract';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../db/prisma.js';
import { downloadFileToTemp, cleanupTempFile, isSupabaseUrl, getFilenameFromUrl } from './urlHandler.js';
import { extractStructuredData } from './bedrock.service.js';

const textractClient = new TextractClient();

export interface InvoiceOcrExtractionResult {
  supplierName: string | null;
  invoiceDate: Date | null;
  totalAmount: number | null;
  invoiceNumber: string | null;
  poNumber: string | null;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    unit: string | null;
    poNumber: string | null;
  }>;
  rawResponse: any;
}

/**
 * Extract expense/invoice data using AWS Textract AnalyzeExpense
 */
export async function extractExpenseFromLocalImage(imageUrl: string): Promise<InvoiceOcrExtractionResult> {
  let localPath = imageUrl;
  let tempFile: string | null = null;

  try {
    // Handle Supabase URLs
    if (isSupabaseUrl(imageUrl)) {
      console.log(`[Invoice OCR] Downloading from Supabase: ${imageUrl.substring(0, 50)}...`);
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

    // Extract with AWS Textract
    return await extractInvoiceWithTextract(localPath);
  } finally {
    // Clean up temporary file if it was downloaded
    if (tempFile) {
      await cleanupTempFile(tempFile);
    }
  }
}

/**
 * Extract invoice data using AWS Textract AnalyzeExpense
 */
async function extractInvoiceWithTextract(localPath: string): Promise<InvoiceOcrExtractionResult> {
  const imageBytes = fs.readFileSync(localPath);

  const command = new AnalyzeExpenseCommand({
    Document: {
      Bytes: imageBytes,
    },
  });

  const response = await textractClient.send(command);
  const rawText = getRawTextFromExpenseResponse(response);

  const logPath = path.join(process.cwd(), 'ocr_debug.log');
  fs.appendFileSync(logPath, `\n--- RAW OCR TEXT ---\n${rawText}\n--------------------\n`);

  const extraction = await extractStructuredData(rawText, 'INVOICE');

  // Debug: log what Bedrock returned
  console.log('[InvoiceOCR] Bedrock extracted supplierName:', extraction.supplierName);
  console.log('[InvoiceOCR] Bedrock extracted lineItems:', JSON.stringify(
    (extraction.lineItems || []).map(i => ({ desc: i.description, qty: i.quantity, unit: i.unit })),
    null, 2
  ));

  // Helper: extract unit from raw text near a quantity
  function inferUnit(description: string, rawOcrText: string): string {
    // Search raw text for a line containing the description and a unit word
    const unitPattern = /\b(\d+\.?\d*)\s*(tons?|tonnes?|lbs?|pounds?|kg|cy|ea|each|cubic yards?|tm)\b/gi;
    const lines = rawOcrText.split('\n');
    const descLower = description.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const line of lines) {
      const lineLower = line.toLowerCase().replace(/[^a-z0-9\s]/g, '');
      if (lineLower.includes(descLower.substring(0, Math.min(4, descLower.length)))) {
        const m = line.match(unitPattern);
        if (m) {
          const unitMatch = m[0].match(/[a-zA-Z]+$/);
          if (unitMatch) return unitMatch[0].toLowerCase();
        }
      }
    }
    // Scan full raw text for unit patterns near quantities
    const allMatches = rawOcrText.match(unitPattern);
    if (allMatches && allMatches.length > 0) {
      const unitMatch = allMatches[0].match(/[a-zA-Z]+$/);
      if (unitMatch) return unitMatch[0].toLowerCase();
    }
    return 'ea';
  }

  return {
    supplierName: extraction.supplierName,
    invoiceDate: extraction.date,
    totalAmount: extraction.totalAmount || null,
    invoiceNumber: extraction.invoiceNumber || null,
    poNumber: extraction.poNumber || null,
    lineItems: (extraction.lineItems || []).map(item => {
      const resolvedUnit = (item.unit && item.unit.trim().length > 0)
        ? item.unit.trim()
        : inferUnit(item.description, rawText);
      console.log(`[InvoiceOCR] Line "${item.description}": AI unit="${item.unit}" → resolved="${resolvedUnit}"`);
      return {
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        unit: resolvedUnit,
        poNumber: item.poNumber,
      };
    }),
    rawResponse: {
      textract: response,
      bedrock: extraction,
    },
  };
}

/**
 * Helper to get raw text from AnalyzeExpense response
 */
function getRawTextFromExpenseResponse(response: any): string {
  const lines: string[] = [];
  const docs = response.ExpenseDocuments || [];
  for (const doc of docs) {
    const blocks = doc.Blocks || [];
    for (const block of blocks) {
      if (block.BlockType === 'LINE' && block.Text) {
        lines.push(block.Text);
      }
    }
  }
  return lines.join('\n');
}
