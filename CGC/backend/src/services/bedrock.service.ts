import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { env } from '../config/env.js';

const bedrockClient = new BedrockRuntimeClient({ region: env.awsRegion });

export interface BedrockExtractionResult {
  supplierName: string | null;
  date: Date | null;
  invoiceNumber?: string | null;
  ticketNumber?: string | null;
  totalAmount?: number | null;
  poNumber: string | null;
  material?: string | null;
  quantity: number | null;
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    poNumber: string | null;
  }>;
}

/**
 * Uses AWS Bedrock to extract structured data from raw OCR text.
 */
export async function extractStructuredData(
  rawText: string,
  docType: 'TICKET' | 'INVOICE'
): Promise<BedrockExtractionResult> {
  const prompt = craftPrompt(rawText, docType);

  const command = new InvokeModelCommand({
    modelId: env.bedrockModelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  try {
    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const textOutput = responseBody.content[0].text;
    
    // Extract JSON from the markdown block if present
    const jsonMatch = textOutput.match(/```json\n([\s\S]*?)\n```/) || textOutput.match(/{([\s\S]*)}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ? `{${jsonMatch[1]}}` : jsonMatch[0]) : textOutput;
    
    const parsed = JSON.parse(jsonStr);
    
    // Normalize dates
    if (parsed.date) {
      const d = new Date(parsed.date);
      parsed.date = isNaN(d.getTime()) ? null : d;
    }

    return parsed as BedrockExtractionResult;
  } catch (error) {
    console.error('[Bedrock] Extraction failed:', error);
    throw new Error(`Bedrock intelligent parsing failed: ${(error as any).message}`);
  }
}

function craftPrompt(rawText: string, docType: 'TICKET' | 'INVOICE'): string {
  if (docType === 'TICKET') {
    return `
You are an expert logistics clerk. Extract structured data from this raw OCR text of a delivery ticket (scale ticket).
Return ONLY a JSON object.

Raw Text:
"""
${rawText}
"""

Expected JSON Schema:
{
  "supplierName": "Full name of the supplier",
  "date": "YYYY-MM-DD",
  "ticketNumber": "The ticket or reference number",
  "poNumber": "The Purchase Order number if present",
  "material": "Type of material (e.g. A Gravel, Sand, etc.)",
  "quantity": number (only the numeric value),
  "unit": "tons, lbs, etc."
}
`;
  } else {
    return `
You are an expert Accounts Payable clerk. Extract structured data from this raw OCR text of an invoice.
Return ONLY a JSON object.

Raw Text:
"""
${rawText}
"""

Expected JSON Schema:
{
  "supplierName": "Full name of the company sending the invoice",
  "invoiceNumber": "The invoice ID",
  "date": "YYYY-MM-DD",
  "poNumber": "The header-level PO number if present",
  "totalAmount": number,
  "lineItems": [
    {
      "description": "Full description of the item",
      "quantity": number,
      "unitPrice": number,
      "totalPrice": number,
      "poNumber": "PO number for this specific line. IMPORTANT: Extract this for every line even if it matches the header PO."
    }
  ]
}
`;
  }
}
