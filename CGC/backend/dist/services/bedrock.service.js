import { BedrockRuntimeClient, InvokeModelCommand, } from '@aws-sdk/client-bedrock-runtime';
import { env } from '../config/env.js';
const bedrockClient = new BedrockRuntimeClient({ region: env.awsRegion });
/**
 * Uses AWS Bedrock to extract structured data from raw OCR text.
 */
export async function extractStructuredData(rawText, docType) {
    console.log('[Bedrock] DOC TYPE:', docType);
    console.log('[Bedrock] RAW TEXT LENGTH:', rawText.length);
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
        // Normalize PO Number (must be exactly 6 digits)
        if (parsed.poNumber) {
            const cleaned = String(parsed.poNumber).replace(/\D/g, '');
            if (cleaned.length === 6) {
                parsed.poNumber = cleaned;
            }
        }
        // Normalize Line Item PO Numbers
        if (parsed.lineItems && Array.isArray(parsed.lineItems)) {
            parsed.lineItems = parsed.lineItems.map((item) => {
                if (item.poNumber) {
                    const cleaned = String(item.poNumber).replace(/\D/g, '');
                    if (cleaned.length === 6)
                        item.poNumber = cleaned;
                }
                return item;
            });
        }
        return parsed;
    }
    catch (error) {
        console.error('[Bedrock] Extraction failed:', error);
        throw new Error(`Bedrock intelligent parsing failed: ${error.message}`);
    }
}
function craftPrompt(rawText, docType) {
    if (docType === 'TICKET') {
        return `
You are an expert logistics clerk. Extract structured data from this raw OCR text of a delivery ticket (scale ticket).
Return ONLY a valid JSON object. Do not include any conversational text or explanations. If you cannot find a value, use null.

Raw Text:
"""
${rawText}
"""

Expected JSON Schema:
{
  "supplierName": "The name of the Vendor/Supplier issuing the ticket. IMPORTANT: Ignore 'Cambridge Garden Centre' as it is the Bill To customer. Look at the top of the page for the company issuing the ticket (e.g., 'ABC Aggregate Suppliers', 'Dufferin Aggregates').",
  "date": "YYYY-MM-DD",
  "ticketNumber": "The ticket or reference number",
  "poNumber": "The Purchase Order number. IMPORTANT: This is always exactly a 6-digit numerical value (e.g., 123456).",
  "material": "Type of material (e.g. A Gravel, Sand, etc.)",
  "quantity": number (only the numeric value),
  "unit": "tons, lbs, each, etc. (Always extract the unit shown on the ticket)"
}
`;
    }
    else {
        return `
You are an expert Accounts Payable clerk. Extract structured data from this raw OCR text of an invoice.
Return ONLY a valid JSON object. Do not include any conversational text or explanations. If you cannot find a value, use null.

Raw Text:
"""
${rawText}
"""

Expected JSON Schema:
{
  "supplierName": "The name of the Vendor/Supplier sending the invoice. IMPORTANT: Ignore 'Cambridge Garden Centre' as it is the Bill To customer. Look at the top of the page for the company issuing the invoice (e.g., 'Dufferin Aggregates').",
  "invoiceNumber": "The invoice ID",
  "date": "YYYY-MM-DD",
  "poNumber": "The header-level PO number. IMPORTANT: This is always exactly a 6-digit numerical value (e.g., 123456).",
  "totalAmount": number,
  "lineItems": [
    {
      "description": "Full description of the item",
      "quantity": number,
      "unit": "The unit of measure (e.g., 'tons', 'tonnes', 'cy'). This is REQUIRED for every line. Look for it next to the quantity.",
      "unitPrice": number,
      "totalPrice": number,
      "poNumber": "PO number for this specific line. IMPORTANT: Extract this for every line even if it matches the header PO. This must be a 6-digit numerical value."
    }
  ]
}
`;
    }
}
//# sourceMappingURL=bedrock.service.js.map