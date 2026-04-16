import { TextractClient, AnalyzeExpenseCommand, } from '@aws-sdk/client-textract';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../db/prisma.js';
import { downloadFileToTemp, cleanupTempFile, isSupabaseUrl, getFilenameFromUrl } from './urlHandler.js';
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
    const result = {
        supplierName: null,
        invoiceDate: null,
        totalAmount: null,
        invoiceNumber: null,
        lineItems: [],
        rawResponse: response,
    };
    const expenseDocs = response.ExpenseDocuments || [];
    if (expenseDocs.length === 0) {
        return result; // No data detected
    }
    const doc = expenseDocs[0];
    if (!doc)
        return result;
    // Parse SummaryFields (Vendor, Date, Invoice Number, Total)
    const summaryFields = doc.SummaryFields || [];
    for (const field of summaryFields) {
        const typeName = field.Type?.Text;
        const valueStr = field.ValueDetection?.Text;
        if (!typeName || !valueStr)
            continue;
        if (typeName === 'VENDOR_NAME') {
            result.supplierName = valueStr;
        }
        else if (typeName === 'INVOICE_RECEIPT_DATE' || typeName === 'DATE') {
            const parsedDate = new Date(valueStr);
            if (!isNaN(parsedDate.getTime())) {
                result.invoiceDate = parsedDate;
            }
        }
        else if (typeName === 'INVOICE_RECEIPT_ID' || typeName === 'INVOICE_ID') {
            result.invoiceNumber = valueStr;
        }
        else if (typeName === 'TOTAL') {
            const numericVal = parseFloat(valueStr.replace(/[^0-9.]/g, ''));
            if (!isNaN(numericVal))
                result.totalAmount = numericVal;
        }
    }
    // Parse LineItems
    const lineItemGroups = doc.LineItemGroups || [];
    for (const group of lineItemGroups) {
        const items = group.LineItems || [];
        for (const item of items) {
            const fields = item.LineItemExpenseFields || [];
            let description = '';
            let quantity = 0;
            let unitPrice = 0;
            let totalPrice = 0;
            for (const field of fields) {
                const typeName = field.Type?.Text;
                const valueStr = field.ValueDetection?.Text;
                if (!typeName || !valueStr)
                    continue;
                if (typeName === 'EXPENSE_ROW') {
                    // generic row details, we skip or use if specific details are absent
                }
                else if (typeName === 'ITEM' || typeName === 'DESCRIPTION') {
                    description = valueStr;
                }
                else if (typeName === 'QUANTITY') {
                    quantity = parseFloat(valueStr.replace(/[^0-9.]/g, '')) || 0;
                }
                else if (typeName === 'UNIT_PRICE') {
                    unitPrice = parseFloat(valueStr.replace(/[^0-9.]/g, '')) || 0;
                }
                else if (typeName === 'PRICE' || typeName === 'TOTAL') {
                    totalPrice = parseFloat(valueStr.replace(/[^0-9.]/g, '')) || 0;
                }
            }
            if (description) {
                result.lineItems.push({
                    description,
                    quantity,
                    unitPrice,
                    totalPrice,
                });
            }
        }
    }
    return result;
}
//# sourceMappingURL=invoiceOcr.service.js.map