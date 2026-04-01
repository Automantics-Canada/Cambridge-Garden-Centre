import {
  TextractClient,
  DetectDocumentTextCommand,
} from '@aws-sdk/client-textract';
import path from 'node:path';
import fs from 'node:fs';

const client = new TextractClient(); // Relies on standard AWS credential provider chain

export interface OcrExtractionResult {
  rawText: string;
  supplierName: string | null;
  ticketDate: Date | null;
  material: string | null;
  quantity: number | null;
  poNumber: string | null;
  ticketNumber: string | null;
}

export async function extractTextFromLocalImage(imageUrl: string): Promise<OcrExtractionResult> {
  let localPath = imageUrl;
  if (imageUrl.startsWith('/uploads/')) {
    localPath = path.join(process.cwd(), imageUrl);
  }

  if (!fs.existsSync(localPath)) {
    throw new Error(`Local file not found for OCR: ${localPath}`);
  }

  const imageBytes = fs.readFileSync(localPath);

  const command = new DetectDocumentTextCommand({
    Document: {
      Bytes: imageBytes,
    },
  });

  const result = await client.send(command);
  const blocks = result.Blocks;

  if (!blocks || blocks.length === 0) {
    throw new Error('No text detected in the image');
  }

  const textLines = blocks
    .filter((block: any) => block.BlockType === 'LINE' && block.Text)
    .map((block: any) => block.Text as string);

  const rawText = textLines.join('\n');

  return parseTicketData(rawText);
}

function parseTicketData(text: string): OcrExtractionResult {
  
  const result: OcrExtractionResult = {
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
