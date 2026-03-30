import vision from '@google-cloud/vision';
import path from 'node:path';
import fs from 'node:fs';
// Initializes the Vision API client
// It will automatically use the GOOGLE_APPLICATION_CREDENTIALS environment variable
const client = new vision.ImageAnnotatorClient();
export async function extractTextFromLocalImage(imageUrl) {
    // Convert the URL route /uploads/tickets/xxx.jpg to local file system path
    let localPath = imageUrl;
    if (imageUrl.startsWith('/uploads/')) {
        localPath = path.join(process.cwd(), imageUrl);
    }
    if (!fs.existsSync(localPath)) {
        throw new Error(`Local file not found for OCR: ${localPath}`);
    }
    // Performs text detection on the local file
    const [result] = await client.documentTextDetection(localPath);
    const detections = result.textAnnotations;
    if (!detections || detections.length === 0) {
        throw new Error('No text detected in the image');
    }
    const rawText = detections[0]?.description || '';
    return parseTicketData(rawText);
}
function parseTicketData(text) {
    // Simple heuristic-based extraction. 
    // In a production system, these regexes should be refined or LLM should be used.
    const result = {
        rawText: text,
        supplierName: null,
        ticketDate: null,
        material: null,
        quantity: null,
        poNumber: null,
        ticketNumber: null,
    };
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // Supplier Name: often at the very top of the ticket. Let's just grab the first line if it looks like letters.
    if (lines.length > 0) {
        result.supplierName = lines[0] || null;
    }
    // Ticket Date (e.g., 2023-10-12, 10/12/2023)
    const dateRegex = /\b(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\b/;
    const dateMatch = text.match(dateRegex);
    if (dateMatch && dateMatch[1]) {
        const parsedDate = new Date(dateMatch[1]);
        if (!isNaN(parsedDate.getTime())) {
            result.ticketDate = parsedDate;
        }
    }
    // Ticket Number
    const ticketRegex = /Ticket\s*#?\s*[:\-]?\s*([A-Za-z0-9]+)/i;
    const ticketMatch = text.match(ticketRegex);
    if (ticketMatch && ticketMatch[1]) {
        result.ticketNumber = ticketMatch[1] || null;
    }
    // PO Number
    const poRegex = /PO\s*#?\s*[:\-]?\s*([A-Za-z0-9]+)/i;
    const poMatch = text.match(poRegex);
    if (poMatch && poMatch[1]) {
        result.poNumber = poMatch[1];
    }
    // Quantity (e.g. 15.5 tons, 20 tonnes)
    const qtyRegex = /([\d.,]+)\s*(tons?|tonnes?|lbs?|kg|t)/i;
    const qtyMatch = text.match(qtyRegex);
    if (qtyMatch && qtyMatch[1]) {
        const qtyVal = parseFloat(qtyMatch[1].replace(/,/g, ''));
        if (!isNaN(qtyVal)) {
            result.quantity = qtyVal;
        }
    }
    // Material: simple generic list check or look for common words like "aggregate", "sand", "gravel", "stone"
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
//# sourceMappingURL=ocr.service.js.map