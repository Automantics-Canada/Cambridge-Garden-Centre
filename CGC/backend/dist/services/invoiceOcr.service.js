import { TextractClient, AnalyzeExpenseCommand, } from '@aws-sdk/client-textract';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../db/prisma.js';
import { downloadFileToTemp, cleanupTempFile, isSupabaseUrl, getFilenameFromUrl } from './urlHandler.js';
import { extractStructuredData } from './bedrock.service.js';
const textractClient = new TextractClient();
/**
 * Extract expense/invoice data using AWS Textract AnalyzeExpense
 */
export async function extractExpenseFromLocalImage(imageUrl) {
    let localPath = imageUrl;
    let tempFile = null;
    try {
        // Handle Supabase URLs
        if (isSupabaseUrl(imageUrl)) {
            console.log(`[Invoice OCR] Downloading from Supabase: ${imageUrl.substring(0, 50)}...`);
            const filename = getFilenameFromUrl(imageUrl);
            tempFile = await downloadFileToTemp(imageUrl, filename);
            localPath = tempFile;
        }
        else if (imageUrl.startsWith('/uploads/')) {
            // Handle legacy local paths
            localPath = path.join(process.cwd(), imageUrl);
        }
        if (!fs.existsSync(localPath)) {
            throw new Error(`Local file not found for OCR: ${localPath}`);
        }
        // Extract with AWS Textract
        return await extractInvoiceWithTextract(localPath);
    }
    finally {
        // Clean up temporary file if it was downloaded
        if (tempFile) {
            await cleanupTempFile(tempFile);
        }
    }
}
/**
 * Extract invoice data using AWS Textract AnalyzeExpense
 */
async function extractInvoiceWithTextract(localPath) {
    const imageBytes = fs.readFileSync(localPath);
    const command = new AnalyzeExpenseCommand({
        Document: {
            Bytes: imageBytes,
        },
    });
    const response = await textractClient.send(command);
    const rawText = getRawTextFromExpenseResponse(response);
    const extraction = await extractStructuredData(rawText, 'INVOICE');
    return {
        supplierName: extraction.supplierName,
        invoiceDate: extraction.date,
        totalAmount: extraction.totalAmount || null,
        invoiceNumber: extraction.invoiceNumber || null,
        poNumber: extraction.poNumber || null,
        lineItems: (extraction.lineItems || []).map(item => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
            poNumber: item.poNumber,
        })),
        rawResponse: {
            textract: response,
            bedrock: extraction,
        },
    };
}
/**
 * Helper to get raw text from AnalyzeExpense response
 */
function getRawTextFromExpenseResponse(response) {
    const lines = [];
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
//# sourceMappingURL=invoiceOcr.service.js.map